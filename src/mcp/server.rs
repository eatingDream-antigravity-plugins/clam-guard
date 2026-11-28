use crate::mcp::telemetry::TelemetryEngine;
use crate::mcp::tools::{
    call_tool_json, is_tool_allowed, list_resources_json, list_tools_json, read_resource_json,
    HtmlLoader, APP_MIME, SERVER_NAME, SERVER_VERSION,
};
use crate::platform::display_ffi::{DisplayBackend, MacOsDisplayBackend};
use crate::platform::fan::MacOsFanSensorSource;
use crate::platform::macos::{MacOsProbeBackend, ProbeBackend};
use serde_json::{json, Value};
use std::io::{self, BufRead, BufWriter, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const DEFAULT_SERVE_GUARD_INTERVAL_MS: u64 = 5_000;
pub const MAX_STDIN_LINE_BYTES: usize = 1024 * 1024;
pub const MAX_JSONRPC_BATCH_LEN: usize = 32;

pub const SUPPORTED_PROTOCOL_VERSIONS: &[&str] =
    &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
pub const LATEST_PROTOCOL_VERSION: &str = "2025-11-25";
const UI_EXTENSION: &str = "io.modelcontextprotocol/ui";

pub struct McpSession {
    apps_capable: bool,
    protocol_version: &'static str,
    initialized: bool,
}

impl Default for McpSession {
    fn default() -> Self {
        Self {
            apps_capable: false,
            protocol_version: LATEST_PROTOCOL_VERSION,
            initialized: false,
        }
    }
}

impl McpSession {
    pub fn supports_jsonrpc_batch(&self) -> bool {
        matches!(self.protocol_version, "2025-03-26" | "2024-11-05")
    }
}

fn jsonrpc_err(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message.into() }
    })
}

fn invalid_request_err(message: impl Into<String>) -> Value {
    jsonrpc_err(Value::Null, -32600, message)
}

fn is_valid_mcp_id(val: &Value) -> bool {
    match val {
        Value::String(_) => true,
        Value::Number(n) => n.is_i64() || n.is_u64(),
        _ => false,
    }
}

fn negotiate_protocol_version(requested: Option<&str>) -> &'static str {
    if let Some(req) = requested {
        for &supported in SUPPORTED_PROTOCOL_VERSIONS {
            if supported == req {
                return supported;
            }
        }
    }
    LATEST_PROTOCOL_VERSION
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LineRead {
    Eof,
    Line,
    TooLong,
}

fn read_bounded_line<R: BufRead>(
    reader: &mut R,
    buf: &mut Vec<u8>,
    max_bytes: usize,
) -> io::Result<LineRead> {
    buf.clear();
    let mut read_any = false;
    let mut too_long = false;
    loop {
        let available = match reader.fill_buf() {
            Ok(b) => b,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        if available.is_empty() {
            return Ok(if too_long {
                LineRead::TooLong
            } else if read_any {
                LineRead::Line
            } else {
                LineRead::Eof
            });
        }
        read_any = true;
        let newline_pos = available.iter().position(|&b| b == b'\n');
        let take = newline_pos.map_or(available.len(), |idx| idx + 1);
        if !too_long {
            if buf.len().saturating_add(take) > max_bytes {
                too_long = true;
                buf.clear();
            } else {
                buf.extend_from_slice(&available[..take]);
            }
        }
        reader.consume(take);
        if newline_pos.is_some() {
            return Ok(if too_long {
                LineRead::TooLong
            } else {
                LineRead::Line
            });
        }
    }
}

fn handle_single_rpc<P: ProbeBackend + 'static, D: DisplayBackend + 'static>(
    msg: &Value,
    session: &mut McpSession,
    engine: &Arc<TelemetryEngine<P, D>>,
    html_loader: &HtmlLoader,
) -> Option<Value> {
    let Some(obj) = msg.as_object() else {
        return Some(invalid_request_err("Invalid Request"));
    };

    let raw_id = obj.get("id");
    let id_valid = raw_id.is_none_or(is_valid_mcp_id);
    let err_id = match raw_id {
        Some(v) if is_valid_mcp_id(v) => v.clone(),
        _ => Value::Null,
    };

    let valid_version = obj.get("jsonrpc").and_then(Value::as_str) == Some("2.0");
    let method_opt = obj
        .get("method")
        .and_then(Value::as_str)
        .filter(|m| !m.is_empty());
    let valid_params = obj.get("params").is_none_or(Value::is_object);

    if !id_valid || !valid_version || method_opt.is_none() || !valid_params {
        return Some(jsonrpc_err(err_id, -32600, "Invalid Request"));
    }

    // Notifications (no id) require no JSON-RPC response.
    let id = raw_id?.clone();
    let method = method_opt.unwrap_or_default();
    let params = obj.get("params").cloned().unwrap_or_else(|| json!({}));

    let ok = |result: Value| {
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": result
        })
    };
    let err = |code: i64, message: String| jsonrpc_err(id.clone(), code, message);

    match method {
        "initialize" => {
            if session.initialized {
                return Some(err(
                    -32600,
                    "Invalid Request: session already initialized".to_string(),
                ));
            }
            let client_proto =
                negotiate_protocol_version(params.get("protocolVersion").and_then(Value::as_str));
            // SEP-1865 requires extensions["io.modelcontextprotocol/ui"].mimeTypes to be an array
            // explicitly including "text/html;profile=mcp-app".
            let apps_capable = params["capabilities"]["extensions"][UI_EXTENSION]
                .as_object()
                .and_then(|ui| ui.get("mimeTypes"))
                .and_then(|types| types.as_array())
                .is_some_and(|types| types.iter().any(|v| v.as_str() == Some(APP_MIME)));
            session.protocol_version = client_proto;
            session.apps_capable = apps_capable;
            session.initialized = true;

            let mut capabilities = json!({"tools": {}, "resources": {}});
            if session.apps_capable {
                capabilities["extensions"] = json!({UI_EXTENSION: {"mimeTypes": [APP_MIME]}});
            }
            Some(ok(json!({
                "protocolVersion": client_proto,
                "capabilities": capabilities,
                "serverInfo": {
                    "name": SERVER_NAME,
                    "version": SERVER_VERSION
                }
            })))
        }
        "ping" => Some(ok(json!({}))),
        "resources/list" => Some(ok(list_resources_json())),
        "resources/read" => {
            let uri = params.get("uri").and_then(|v| v.as_str()).unwrap_or("");
            match read_resource_json(uri, engine, html_loader) {
                Ok(res) => Some(ok(res)),
                Err(e) => Some(err(-32602, e)),
            }
        }
        "tools/list" => Some(ok(list_tools_json(session.apps_capable))),
        "tools/call" => {
            if !session.initialized {
                return Some(err(
                    -32600,
                    "Invalid Request: session not initialized".to_string(),
                ));
            }
            let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if !is_tool_allowed(name, session.apps_capable) {
                return Some(err(
                    -32602,
                    format!("Tool not available in this session: {name}"),
                ));
            }
            let args = match params.get("arguments") {
                None => json!({}),
                Some(v) if v.is_object() => v.clone(),
                Some(_) => {
                    return Some(err(
                        -32602,
                        "Invalid params: arguments must be a JSON object".to_string(),
                    ));
                }
            };
            Some(ok(call_tool_json(name, &args, engine)))
        }
        other => Some(err(-32601, format!("Method not found: {other}"))),
    }
}

pub fn handle_rpc_value_with_session<P: ProbeBackend + 'static, D: DisplayBackend + 'static>(
    msg: &Value,
    session: &mut McpSession,
    engine: &Arc<TelemetryEngine<P, D>>,
    html_loader: &HtmlLoader,
) -> Option<Value> {
    if let Some(batch) = msg.as_array() {
        if batch.is_empty() {
            return Some(invalid_request_err("Invalid Request: empty batch"));
        }
        if !session.supports_jsonrpc_batch() {
            return Some(invalid_request_err(format!(
                "Invalid Request: JSON-RPC batching is not supported in MCP {}",
                session.protocol_version
            )));
        }
        if batch.len() > MAX_JSONRPC_BATCH_LEN {
            return Some(invalid_request_err(format!(
                "Invalid Request: JSON-RPC batch exceeds maximum length of {MAX_JSONRPC_BATCH_LEN}"
            )));
        }
        let contains_initialize = batch.iter().any(|item| {
            item.as_object()
                .and_then(|o| o.get("method"))
                .and_then(Value::as_str)
                == Some("initialize")
        });
        if contains_initialize {
            return Some(invalid_request_err(
                "Invalid Request: initialize cannot be sent in a JSON-RPC batch",
            ));
        }
        let responses: Vec<Value> = batch
            .iter()
            .filter_map(|item| handle_single_rpc(item, session, engine, html_loader))
            .collect();
        if responses.is_empty() {
            None
        } else {
            Some(Value::Array(responses))
        }
    } else {
        handle_single_rpc(msg, session, engine, html_loader)
    }
}

pub fn serve_stdio(data_dir: PathBuf, panel_html_override: Option<PathBuf>) -> io::Result<()> {
    let binary_path = std::env::current_exe()
        .ok()
        .and_then(|p| p.to_str().map(str::to_string))
        .unwrap_or_else(|| "mac-clamshell-mcp".to_string());

    let engine = Arc::new(TelemetryEngine::new(
        data_dir.clone(),
        binary_path,
        MacOsProbeBackend::default(),
        MacOsDisplayBackend,
        MacOsFanSensorSource::default(),
    ));
    let html_loader = Arc::new(HtmlLoader::new(panel_html_override));

    // Decouple MCP server lifecycle from the standalone Display Guard daemon while still
    // taking over cleanly if the LaunchAgent is unloaded or an earlier lock holder exits.
    let stop_guard = Arc::new(AtomicBool::new(false));
    let guard_interval_ms = std::env::var("MAC_CLAMSHELL_GUARD_INTERVAL_MS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(DEFAULT_SERVE_GUARD_INTERVAL_MS)
        .clamp(100, 300_000);
    let initial_lock = if crate::launchagent::is_launchagent_active() {
        None
    } else {
        crate::state::DaemonLock::try_acquire(&data_dir)
            .ok()
            .flatten()
    };
    engine.set_bg_guard_active(initial_lock.is_some());
    let guard_handle = {
        let e = Arc::clone(&engine);
        let stop = Arc::clone(&stop_guard);
        let guard_data_dir = data_dir;
        std::thread::Builder::new()
            .name("clamshell-guard".into())
            .spawn(move || {
                let mut owned_lock = initial_lock;
                let probe = MacOsProbeBackend::default();
                let display = MacOsDisplayBackend;
                let normal_dur = Duration::from_millis(guard_interval_ms);
                let fast_dur = Duration::from_millis(
                    guard_interval_ms.min(crate::guard::FAST_POLL_INTERVAL_MS),
                );
                while !stop.load(Ordering::SeqCst) {
                    if crate::launchagent::is_launchagent_active() {
                        // Yield cleanly if LaunchAgent is loaded while MCP server is running.
                        if owned_lock.take().is_some() {
                            e.set_bg_guard_active(false);
                        }
                        e.wait_guard_interval(normal_dur, &stop);
                        continue;
                    }
                    if owned_lock.is_none() {
                        if let Ok(Some(lock)) =
                            crate::state::DaemonLock::try_acquire(&guard_data_dir)
                        {
                            owned_lock = Some(lock);
                            e.set_bg_guard_active(true);
                        }
                    }
                    if owned_lock.is_some() {
                        let fast =
                            crate::guard::run_guard_tick_locked(&guard_data_dir, &probe, &display)
                                .map(|o| o.fast_poll)
                                .unwrap_or(false);
                        e.wait_guard_interval(if fast { fast_dur } else { normal_dur }, &stop);
                    } else {
                        e.wait_guard_interval(normal_dur, &stop);
                    }
                }
            })
            .ok()
    };

    // Pre-warm HTML template and initial telemetry asynchronously so first open is <0.5ms.
    {
        let e = Arc::clone(&engine);
        let h = Arc::clone(&html_loader);
        let _ = std::thread::Builder::new()
            .name("clamshell-prewarm".into())
            .spawn(move || {
                h.prewarm();
                e.prewarm();
            });
    }

    let stdin = io::stdin();
    let stdout = Arc::new(Mutex::new(BufWriter::new(io::stdout())));
    let mut line_buf = Vec::new();
    let mut reader = stdin.lock();
    let mut io_res = Ok(());
    let mut session = McpSession::default();

    let write_response = |resp: &Value| -> io::Result<()> {
        let mut out = stdout.lock().unwrap_or_else(|e| e.into_inner());
        serde_json::to_writer(&mut *out, resp)
            .map_err(io::Error::other)
            .and_then(|_| out.write_all(b"\n"))
            .and_then(|_| out.flush())
    };

    loop {
        match read_bounded_line(&mut reader, &mut line_buf, MAX_STDIN_LINE_BYTES) {
            Ok(LineRead::Eof) => break,
            Ok(LineRead::TooLong) => {
                let err_resp = invalid_request_err(format!(
                    "Invalid Request: JSON-RPC line exceeds {MAX_STDIN_LINE_BYTES} byte limit"
                ));
                if let Err(e) = write_response(&err_resp) {
                    io_res = Err(e);
                    break;
                }
                continue;
            }
            Ok(LineRead::Line) => {}
            Err(e) => {
                io_res = Err(e);
                break;
            }
        }
        let line = match std::str::from_utf8(&line_buf) {
            Ok(s) => s,
            Err(utf8_err) => {
                let err_resp = jsonrpc_err(
                    Value::Null,
                    -32700,
                    format!("Parse error: invalid UTF-8 ({utf8_err})"),
                );
                if let Err(e) = write_response(&err_resp) {
                    io_res = Err(e);
                    break;
                }
                continue;
            }
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(parse_err) => {
                let err_resp =
                    jsonrpc_err(Value::Null, -32700, format!("Parse error: {parse_err}"));
                if let Err(e) = write_response(&err_resp) {
                    io_res = Err(e);
                    break;
                }
                continue;
            }
        };

        if let Some(resp) = handle_rpc_value_with_session(&msg, &mut session, &engine, &html_loader)
        {
            if let Err(e) = write_response(&resp) {
                io_res = Err(e);
                break;
            }
        }
    }

    stop_guard.store(true, Ordering::SeqCst);
    engine.notify_guard_wake();
    if let Some(h) = guard_handle {
        let _ = h.join();
    }

    io_res
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::fan::TestFanSensor;
    use crate::platform::macos::{HardwareProbe, MemorySummary, StaticHostInfo};
    use crate::policy::CpuTopology;
    use std::sync::Mutex;

    struct TestProbe {
        lid_closed: bool,
    }
    impl ProbeBackend for TestProbe {
        fn static_host(&self) -> StaticHostInfo {
            StaticHostInfo {
                hostname: "test-mac".into(),
                chip: "Apple M1 Pro".into(),
                macos_version: "15.4".into(),
                cpu_topology: CpuTopology {
                    total: 8,
                    performance_cores: 6,
                    efficiency_cores: 2,
                },
            }
        }
        fn lid_closed_fast(&self) -> Option<bool> {
            Some(self.lid_closed)
        }
        fn probe_hardware(&self) -> HardwareProbe {
            HardwareProbe {
                lid_state: if self.lid_closed { "closed" } else { "open" }.into(),
                clamshell_causes_sleep: "no".into(),
                power_source: "battery".into(),
                battery_pct: Some(88),
                battery_detail: "-InternalBattery-0\t88%; discharging".into(),
                thermal_state: "ok".into(),
                thermal_pressure: "nominal".into(),
                cpu_speed_limit_pct: None,
                low_power_mode: "0".into(),
                memory: MemorySummary {
                    total_gb: 16.0,
                    used_gb: 8.0,
                    compressed_gb: 1.0,
                    used_pct: 50,
                },
                load_avg: [1.2, 1.1, 1.0],
                uptime_seconds: 7200,
                degraded: false,
            }
        }
    }

    struct TestDisplay {
        builtins: Vec<u32>,
        level: Mutex<f32>,
    }
    impl DisplayBackend for TestDisplay {
        fn get_displays(&self) -> (Vec<u32>, Vec<u32>) {
            (self.builtins.clone(), vec![])
        }
        fn is_asleep(&self, _id: u32) -> Option<bool> {
            Some(false)
        }
        fn get_brightness(&self, _id: u32) -> Option<f32> {
            if self.builtins.is_empty() {
                None
            } else {
                Some(*self.level.lock().unwrap())
            }
        }
        fn set_brightness(&self, _id: u32, level: f32) -> bool {
            if self.builtins.is_empty() {
                return false;
            }
            *self.level.lock().unwrap() = level;
            true
        }
        fn sleep_display_now(&self) -> bool {
            true
        }
        fn lock_screen_now(
            &self,
        ) -> Result<crate::platform::display_ffi::LockScreenOutcome, String> {
            Ok(crate::platform::display_ffi::LockScreenOutcome {
                method: "mock",
                verified: true,
            })
        }
    }

    #[test]
    fn initialize_negotiates_supported_protocol_and_apps_per_session() {
        let engine = Arc::new(TelemetryEngine::new(
            std::env::temp_dir(),
            "mac-clamshell-mcp".into(),
            TestProbe { lid_closed: false },
            TestDisplay {
                builtins: vec![],
                level: Mutex::new(0.0),
            },
            TestFanSensor("fanless"),
        ));
        let html = HtmlLoader::new(None);
        let initialize = |session: &mut McpSession, params| {
            handle_rpc_value_with_session(
                &json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": params}),
                session,
                &engine,
                &html,
            )
            .unwrap()
        };
        let list_tools = |session: &mut McpSession| {
            handle_rpc_value_with_session(
                &json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
                session,
                &engine,
                &html,
            )
            .unwrap()
        };

        for version in SUPPORTED_PROTOCOL_VERSIONS {
            let mut s = McpSession::default();
            let init = initialize(&mut s, json!({"protocolVersion": version}));
            assert_eq!(init["result"]["protocolVersion"], *version);
            // Duplicate initialize MUST be rejected with -32600 without changing capabilities.
            let dup = handle_rpc_value_with_session(
                &json!({
                    "jsonrpc": "2.0",
                    "id": 99,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {"extensions": {UI_EXTENSION: {"mimeTypes": [APP_MIME]}}}
                    }
                }),
                &mut s,
                &engine,
                &html,
            )
            .unwrap();
            assert_eq!(dup["error"]["code"], -32600);
            assert_eq!(dup["id"], 99);
            assert_eq!(
                list_tools(&mut s)["result"]["tools"]
                    .as_array()
                    .unwrap()
                    .len(),
                3
            );
        }
        for params in [json!({"protocolVersion": "2099-01-01"}), json!({})] {
            let mut s = McpSession::default();
            let init = initialize(&mut s, params);
            assert_eq!(init["result"]["protocolVersion"], LATEST_PROTOCOL_VERSION);
            assert!(init["result"]["capabilities"].get("extensions").is_none());
        }

        // SEP-1865 requires mimeTypes array explicitly containing APP_MIME.
        let mut app = McpSession::default();
        let init = initialize(
            &mut app,
            json!({
                "capabilities": {"extensions": {UI_EXTENSION: {"mimeTypes": ["text/plain", APP_MIME]}}}
            }),
        );
        assert_eq!(
            init["result"]["capabilities"]["extensions"][UI_EXTENSION]["mimeTypes"],
            json!([APP_MIME])
        );
        assert_eq!(
            list_tools(&mut app)["result"]["tools"]
                .as_array()
                .unwrap()
                .len(),
            5
        );

        let mut plain = McpSession::default();
        let _ = initialize(&mut plain, json!({"protocolVersion": "2025-11-25"}));
        let tools = list_tools(&mut plain);
        let names: Vec<_> = tools["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            [
                "clamshell_panel",
                "clamshell_set_brightness",
                "clamshell_lock_screen"
            ]
        );
        // Plain session MUST reject app-only tools in tools/call!
        for forbidden in ["clamshell_refresh", "clamshell_configure"] {
            let err_resp = handle_rpc_value_with_session(
                &json!({"jsonrpc": "2.0", "id": 99, "method": "tools/call", "params": {"name": forbidden, "arguments": {}}}),
                &mut plain,
                &engine,
                &html,
            )
            .unwrap();
            assert_eq!(err_resp["error"]["code"], -32602);
            assert!(err_resp.get("result").is_none());
        }

        // Empty object {} and missing/mismatched mimeTypes MUST NOT enable Apps
        for capability in [
            json!({}),
            json!({"mimeTypes": ["text/html"]}),
            json!({"mimeTypes": null}),
            json!(null),
        ] {
            let mut s = McpSession::default();
            let init = initialize(
                &mut s,
                json!({
                    "capabilities": {"extensions": {UI_EXTENSION: capability}}
                }),
            );
            assert!(init["result"]["capabilities"].get("extensions").is_none());
            assert_eq!(
                list_tools(&mut s)["result"]["tools"]
                    .as_array()
                    .unwrap()
                    .len(),
                3
            );
            let err_resp = handle_rpc_value_with_session(
                &json!({"jsonrpc": "2.0", "id": 100, "method": "tools/call", "params": {"name": "clamshell_configure", "arguments": {"guardEnabled": false}}}),
                &mut s,
                &engine,
                &html,
            )
            .unwrap();
            assert_eq!(err_resp["error"]["code"], -32602);
        }

        // Strict JSON-RPC 2.0 validation: version, method, id, and params types
        for bad_req in [
            json!({"id": 1, "method": "ping"}),
            json!({"jsonrpc": "1.0", "id": 1, "method": "ping"}),
            json!({"jsonrpc": "2.0", "id": 1}),
            json!({"jsonrpc": "2.0", "id": 1, "method": 123}),
            json!({"jsonrpc": "2.0", "id": null, "method": "ping"}),
            json!({"jsonrpc": "2.0", "id": true, "method": "ping"}),
            json!({"jsonrpc": "2.0", "id": [1], "method": "ping"}),
            json!({"jsonrpc": "2.0", "id": {"k": 1}, "method": "ping"}),
            json!({"jsonrpc": "2.0", "id": 1, "method": "ping", "params": 42}),
            json!({"jsonrpc": "2.0", "id": 1, "method": "ping", "params": [1]}),
        ] {
            let resp = handle_rpc_value_with_session(&bad_req, &mut plain, &engine, &html).unwrap();
            assert_eq!(resp["error"]["code"], -32600, "bad_req={bad_req}");
            assert!(
                resp["id"].is_null() || resp["id"].is_i64() || resp["id"].is_string(),
                "invalid id must never be echoed: {resp}"
            );
        }

        // JSON-RPC batch arrays MUST be rejected on 2025-06-18+ (and 2025-11-25)
        for ver in ["2025-06-18", "2025-11-25"] {
            let mut modern = McpSession::default();
            let _ = initialize(&mut modern, json!({"protocolVersion": ver}));
            let rejected = handle_rpc_value_with_session(
                &json!([{"jsonrpc": "2.0", "id": 10, "method": "ping"}]),
                &mut modern,
                &engine,
                &html,
            )
            .unwrap();
            assert_eq!(rejected["error"]["code"], -32600);
        }

        // JSON-RPC 2.0 batch handling on 2025-03-26 (and batched initialize MUST be rejected)
        let mut legacy = McpSession::default();
        let _ = initialize(&mut legacy, json!({"protocolVersion": "2025-03-26"}));
        let batched_init = handle_rpc_value_with_session(
            &json!([{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}]),
            &mut legacy,
            &engine,
            &html,
        )
        .unwrap();
        assert_eq!(batched_init["error"]["code"], -32600);

        let batch_resp = handle_rpc_value_with_session(
            &json!([
                {"jsonrpc": "2.0", "id": 10, "method": "ping"},
                {"jsonrpc": "2.0", "method": "notifications/initialized"},
                {"jsonrpc": "2.0", "id": 11, "method": "ping"}
            ]),
            &mut legacy,
            &engine,
            &html,
        )
        .unwrap();
        let arr = batch_resp.as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["id"], 10);
        assert_eq!(arr[0]["result"], json!({}));
        assert_eq!(arr[1]["id"], 11);
        assert_eq!(arr[1]["result"], json!({}));

        // Notification-only batch emits no response; empty batch emits -32600
        assert!(handle_rpc_value_with_session(
            &json!([{"jsonrpc": "2.0", "method": "notifications/initialized"}]),
            &mut legacy,
            &engine,
            &html,
        )
        .is_none());
        let empty_batch =
            handle_rpc_value_with_session(&json!([]), &mut legacy, &engine, &html).unwrap();
        assert_eq!(empty_batch["error"]["code"], -32600);

        // Bounded line reader rejects >max_bytes cleanly and recovers on subsequent line
        let mut cursor = io::Cursor::new(b"1234567890\nok\n".to_vec());
        let mut buf = Vec::new();
        assert_eq!(
            read_bounded_line(&mut cursor, &mut buf, 8).unwrap(),
            LineRead::TooLong
        );
        assert_eq!(
            read_bounded_line(&mut cursor, &mut buf, 8).unwrap(),
            LineRead::Line
        );
        assert_eq!(buf, b"ok\n");
        assert_eq!(
            read_bounded_line(&mut cursor, &mut buf, 8).unwrap(),
            LineRead::Eof
        );

        // Uninitialized session MUST reject tools/call with -32600
        let mut uninit = McpSession::default();
        for tool in [
            "clamshell_panel",
            "clamshell_set_brightness",
            "clamshell_lock_screen",
        ] {
            let uninit_resp = handle_rpc_value_with_session(
                &json!({"jsonrpc": "2.0", "id": 12, "method": "tools/call", "params": {"name": tool, "arguments": {}}}),
                &mut uninit,
                &engine,
                &html,
            )
            .unwrap();
            assert_eq!(uninit_resp["error"]["code"], -32600);
        }

        // Legacy batch arrays are capped at MAX_JSONRPC_BATCH_LEN (32 ok, 33 -> -32600)
        let ok_batch: Vec<Value> = (0..MAX_JSONRPC_BATCH_LEN)
            .map(|i| json!({"jsonrpc": "2.0", "id": i, "method": "ping"}))
            .collect();
        let ok_batch_resp =
            handle_rpc_value_with_session(&Value::Array(ok_batch), &mut legacy, &engine, &html)
                .unwrap();
        assert_eq!(
            ok_batch_resp.as_array().unwrap().len(),
            MAX_JSONRPC_BATCH_LEN
        );

        let too_many: Vec<Value> = (0..=MAX_JSONRPC_BATCH_LEN)
            .map(|i| json!({"jsonrpc": "2.0", "id": i, "method": "ping"}))
            .collect();
        let too_many_resp =
            handle_rpc_value_with_session(&Value::Array(too_many), &mut legacy, &engine, &html)
                .unwrap();
        assert_eq!(too_many_resp["error"]["code"], -32600);
    }

    #[test]
    fn mcp_rpc_end_to_end_ssr_dedup_configure_brightness_and_desktop_error() {
        let dir =
            std::env::temp_dir().join(format!("mac-clamshell-mcp-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let engine = Arc::new(TelemetryEngine::new(
            dir.clone(),
            "mac-clamshell-mcp".into(),
            TestProbe { lid_closed: true },
            TestDisplay {
                builtins: vec![1],
                level: Mutex::new(0.0),
            },
            TestFanSensor("active:2140,2210"),
        ));
        engine.set_bg_guard_active(true);
        let html_loader = HtmlLoader::new(None);
        let mut session = McpSession::default();

        let init = handle_rpc_value_with_session(
            &json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{"extensions":{"io.modelcontextprotocol/ui":{"mimeTypes":[APP_MIME]}}}}}),
            &mut session,
            &engine,
            &html_loader,
        )
        .unwrap();
        assert_eq!(init["result"]["serverInfo"]["name"], "mac-clamshell-mcp");

        let tools = handle_rpc_value_with_session(
            &json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}),
            &mut session,
            &engine,
            &html_loader,
        )
        .unwrap();
        let names: Vec<&str> = tools["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            vec![
                "clamshell_panel",
                "clamshell_refresh",
                "clamshell_configure",
                "clamshell_set_brightness",
                "clamshell_lock_screen"
            ]
        );
        // Verify guardEnabled is exposed in English tools/list schema
        assert_eq!(
            tools["result"]["tools"][2]["inputSchema"]["properties"]["guardEnabled"]["type"],
            "boolean"
        );

        let res = handle_rpc_value_with_session(
            &json!({"jsonrpc":"2.0","id":3,"method":"resources/read","params":{"uri":"ui://mac-clamshell-mcp/panel"}}),
            &mut session,
            &engine,
            &html_loader,
        )
        .unwrap();
        let html = res["result"]["contents"][0]["text"].as_str().unwrap();
        assert!(html.contains("window.__MAC_CLAMSHELL_BOOT__="));
        assert!(html.contains("\"display\":"));
        assert!(html.contains("\"bootTs\":"));
        assert!(!html.contains("/*__MAC_CLAMSHELL_BOOT__*/"));

        let panel = handle_rpc_value_with_session(
            &json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"clamshell_panel","arguments":{}}}),
            &mut session,
            &engine,
            &html_loader,
        )
        .unwrap();
        assert_eq!(
            panel["result"]["structuredContent"]["profileJobs"]["normal"],
            8
        );
        assert_eq!(
            panel["result"]["structuredContent"]["profileJobs"]["utility"],
            2
        );
        assert_eq!(
            panel["result"]["structuredContent"]["profileJobs"]["strict"],
            1
        );
        let hash = panel["result"]["structuredContent"]["hash"]
            .as_str()
            .unwrap()
            .to_string();

        // Matching ifHash returns minimal unchanged: true (including fresh: true live bypass)
        let poll = handle_rpc_value_with_session(
            &json!({"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"clamshell_refresh","arguments":{"ifHash":hash,"force":false}}}),
            &mut session,
            &engine,
            &html_loader,
        )
        .unwrap();
        assert_eq!(poll["result"]["structuredContent"]["unchanged"], true);
        assert_eq!(poll["result"]["content"][0]["text"], "unchanged");

        let fresh_poll = handle_rpc_value_with_session(
            &json!({"jsonrpc":"2.0","id":51,"method":"tools/call","params":{"name":"clamshell_refresh","arguments":{"ifHash":hash,"fresh":true}}}),
            &mut session,
            &engine,
            &html_loader,
        )
        .unwrap();
        assert_eq!(fresh_poll["result"]["structuredContent"]["unchanged"], true);
        assert_eq!(
            fresh_poll["result"]["structuredContent"]["fromCache"],
            false
        );

        let fresh_panel = handle_rpc_value_with_session(
            &json!({"jsonrpc":"2.0","id":52,"method":"tools/call","params":{"name":"clamshell_panel","arguments":{"fresh":true}}}),
            &mut session,
            &engine,
            &html_loader,
        )
        .unwrap();
        assert_eq!(
            fresh_panel["result"]["structuredContent"]["fromCache"],
            false
        );

        // Lock screen tool returns { ok: true, method, locked_at_ms }
        let locked = handle_rpc_value_with_session(
            &json!({"jsonrpc":"2.0","id":53,"method":"tools/call","params":{"name":"clamshell_lock_screen","arguments":{}}}),
            &mut session,
            &engine,
            &html_loader,
        )
        .unwrap();
        assert!(locked["result"].get("isError").is_none());
        assert_eq!(locked["result"]["structuredContent"]["ok"], true);
        assert_eq!(locked["result"]["structuredContent"]["method"], "mock");
        assert!(
            locked["result"]["structuredContent"]["locked_at_ms"]
                .as_u64()
                .unwrap_or(0)
                > 0
        );

        // Closed-lid set_brightness updates saved restore target safely without waking backlight
        let br = handle_rpc_value_with_session(
            &json!({"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"clamshell_set_brightness","arguments":{"percent":45}}}),
            &mut session,
            &engine,
            &html_loader,
        )
        .unwrap();
        assert!(br["result"].get("isError").is_none());
        assert_eq!(
            br["result"]["structuredContent"]["brightnessAction"]["mode"],
            "saved_target"
        );
        assert_eq!(
            br["result"]["structuredContent"]["brightnessAction"]["savedPercent"],
            45
        );
        assert_eq!(br["result"]["structuredContent"]["stale"], false);

        // Configure policy + guardEnabled toggle updates profile, guardStatus, hash, and includes stale
        let cfg = handle_rpc_value_with_session(
            &json!({"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"clamshell_configure","arguments":{"modeOverride":"utility","maxJobsOverride":2,"guardEnabled":false}}}),
            &mut session,
            &engine,
            &html_loader,
        )
        .unwrap();
        assert_eq!(
            cfg["result"]["structuredContent"]["policy"]["profile"],
            "utility"
        );
        assert_eq!(cfg["result"]["structuredContent"]["guardStatus"], "paused");
        assert_eq!(cfg["result"]["structuredContent"]["stale"], false);
        assert_ne!(
            cfg["result"]["structuredContent"]["hash"].as_str().unwrap(),
            hash
        );

        // P2-1: invalid configure fields/values and invalid refresh ifHash return isError: true;
        // full refresh response includes stale.
        for bad_cfg in [
            json!({"modeOverride": "bogus"}),
            json!({"maxJobsOverride": 999}),
            json!({"unknownField": true}),
        ] {
            let err = handle_rpc_value_with_session(
                &json!({"jsonrpc":"2.0","id":70,"method":"tools/call","params":{"name":"clamshell_configure","arguments":bad_cfg}}),
                &mut session,
                &engine,
                &html_loader,
            )
            .unwrap();
            assert_eq!(err["result"]["isError"], true, "bad_cfg={bad_cfg}");
        }
        for bad_refresh in [
            json!({"ifHash": "x".repeat(65)}),
            json!({"ifHash": 123}),
            json!({"unknownField": true}),
        ] {
            let err = handle_rpc_value_with_session(
                &json!({"jsonrpc":"2.0","id":71,"method":"tools/call","params":{"name":"clamshell_refresh","arguments":bad_refresh}}),
                &mut session,
                &engine,
                &html_loader,
            )
            .unwrap();
            assert_eq!(err["result"]["isError"], true, "bad_refresh={bad_refresh}");
        }
        let snake_hash = handle_rpc_value_with_session(
            &json!({"jsonrpc":"2.0","id":710,"method":"tools/call","params":{"name":"clamshell_refresh","arguments":{"if_hash": cfg["result"]["structuredContent"]["hash"]}}}),
            &mut session,
            &engine,
            &html_loader,
        )
        .unwrap();
        assert!(snake_hash["result"].get("isError").is_none());
        assert_eq!(snake_hash["result"]["structuredContent"]["unchanged"], true);
        let full_refresh = handle_rpc_value_with_session(
            &json!({"jsonrpc":"2.0","id":72,"method":"tools/call","params":{"name":"clamshell_refresh","arguments":{"ifHash":"different-hash","force":true}}}),
            &mut session,
            &engine,
            &html_loader,
        )
        .unwrap();
        assert_eq!(full_refresh["result"]["structuredContent"]["stale"], false);

        // Desktop Mac (open/unknown lid + no built-in display) returns explicit isError: true
        // and honors persisted settings.lang via engine.detect_lang() across all tool error paths.
        let desktop_dir = dir.join("desktop");
        crate::state::write_settings(
            &desktop_dir,
            &crate::state::SettingsPatch {
                lang: Some("zh-CN".into()),
                ..crate::state::SettingsPatch::default()
            },
        )
        .unwrap();
        let desktop_engine = Arc::new(TelemetryEngine::new(
            desktop_dir,
            "mac-clamshell-mcp".into(),
            TestProbe { lid_closed: false },
            TestDisplay {
                builtins: vec![],
                level: Mutex::new(0.0),
            },
            TestFanSensor("active:2140,2210"),
        ));
        let desktop_err = handle_rpc_value_with_session(
            &json!({"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"clamshell_set_brightness","arguments":{"percent":50}}}),
            &mut session,
            &desktop_engine,
            &html_loader,
        )
        .unwrap();
        assert_eq!(desktop_err["result"]["isError"], true);
        assert_eq!(
            desktop_err["result"]["structuredContent"]["errorKind"],
            "no_builtin_display"
        );
        assert!(desktop_err["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("没有内建屏幕"));

        let missing_pct_err = handle_rpc_value_with_session(
            &json!({"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"clamshell_set_brightness","arguments":{}}}),
            &mut session,
            &desktop_engine,
            &html_loader,
        )
        .unwrap();
        assert_eq!(missing_pct_err["result"]["isError"], true);
        assert_eq!(
            missing_pct_err["result"]["structuredContent"]["errorKind"],
            "invalid_brightness"
        );
        assert!(missing_pct_err["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("亮度需在 0 到 100 之间"));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
