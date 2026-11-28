use crate::i18n::{parse_lang_tag, Lang};
use crate::mcp::telemetry::{summarize_for_model, TelemetryEngine};
use crate::platform::display_ffi::{clamp_percent, DisplayBackend};
use crate::platform::macos::ProbeBackend;
use crate::state::{now_epoch_ms, read_bounded_regular_file, SettingsPatch, MAX_PANEL_HTML_BYTES};
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Instant, UNIX_EPOCH};

pub const APP_URI: &str = "ui://mac-clamshell-mcp/panel";
pub const APP_MIME: &str = "text/html;profile=mcp-app";
pub const SERVER_NAME: &str = "mac-clamshell-mcp";
pub const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");
const BOOT_PLACEHOLDER: &str = "/*__MAC_CLAMSHELL_BOOT__*/";

const EMBEDDED_PANEL_HTML: &str = include_str!("../../panel/dist/panel.html");

pub struct CompiledTemplate {
    prefix: String,
    suffix: String,
    has_placeholder: bool,
}

impl CompiledTemplate {
    fn from_html(html: &str) -> Self {
        if let Some((prefix, suffix)) = html.split_once(BOOT_PLACEHOLDER) {
            Self {
                prefix: prefix.to_string(),
                suffix: suffix.to_string(),
                has_placeholder: true,
            }
        } else {
            Self {
                prefix: html.to_string(),
                suffix: String::new(),
                has_placeholder: false,
            }
        }
    }

    pub fn render_with_boot(&self, boot_script: &str) -> String {
        if !self.has_placeholder {
            return self.prefix.clone();
        }
        let mut out =
            String::with_capacity(self.prefix.len() + boot_script.len() + self.suffix.len());
        out.push_str(&self.prefix);
        out.push_str(boot_script);
        out.push_str(&self.suffix);
        out
    }
}

struct CachedHtml {
    path: PathBuf,
    mtime_ns: u128,
    size: u64,
    template: Arc<CompiledTemplate>,
}

pub struct HtmlLoader {
    candidate_paths: Vec<PathBuf>,
    embedded: Arc<CompiledTemplate>,
    cache: Mutex<Option<CachedHtml>>,
}

impl HtmlLoader {
    pub fn new(override_path: Option<PathBuf>) -> Self {
        let mut candidate_paths = Vec::with_capacity(3);
        if let Some(p) = override_path {
            candidate_paths.push(p);
        }
        if let Ok(env_p) = std::env::var("MAC_CLAMSHELL_PANEL_HTML") {
            let trimmed = env_p.trim();
            if !trimmed.is_empty() {
                candidate_paths.push(PathBuf::from(trimmed));
            }
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(plugin_root) = exe.parent().and_then(Path::parent) {
                candidate_paths.push(plugin_root.join("panel").join("dist").join("panel.html"));
            }
        }
        Self {
            candidate_paths,
            embedded: Arc::new(CompiledTemplate::from_html(EMBEDDED_PANEL_HTML)),
            cache: Mutex::new(None),
        }
    }

    pub fn prewarm(&self) {
        let _ = self.load();
    }

    pub fn load(&self) -> Arc<CompiledTemplate> {
        let euid = unsafe { libc::geteuid() };
        let mut found: Option<(&PathBuf, u128, u64)> = None;
        for p in &self.candidate_paths {
            if let Ok(meta) = fs::symlink_metadata(p) {
                if !meta.file_type().is_symlink()
                    && meta.is_file()
                    && meta.uid() == euid
                    && meta.len() <= MAX_PANEL_HTML_BYTES as u64
                {
                    let size = meta.len();
                    let mtime_ns = meta
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_nanos())
                        .unwrap_or(0);
                    found = Some((p, mtime_ns, size));
                    break;
                }
            }
        }

        let Some((path, mtime_ns, size)) = found else {
            return Arc::clone(&self.embedded);
        };

        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(ref c) = *cache {
            if c.path == *path && c.mtime_ns == mtime_ns && c.size == size {
                return Arc::clone(&c.template);
            }
        }
        match read_bounded_regular_file(path, MAX_PANEL_HTML_BYTES) {
            Ok(text) if !text.is_empty() => {
                let template = Arc::new(CompiledTemplate::from_html(&text));
                *cache = Some(CachedHtml {
                    path: path.clone(),
                    mtime_ns,
                    size,
                    template: Arc::clone(&template),
                });
                template
            }
            _ => Arc::clone(&self.embedded),
        }
    }
}

pub fn serialize_boot_data(val: &Value) -> String {
    let raw = serde_json::to_string(val).unwrap_or_else(|_| "null".to_string());
    let mut out = String::with_capacity(raw.len() + 32);
    for ch in raw.chars() {
        match ch {
            '<' => out.push_str("\\u003c"),
            '>' => out.push_str("\\u003e"),
            '&' => out.push_str("\\u0026"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            c => out.push(c),
        }
    }
    out
}

pub fn list_resources_json() -> Value {
    json!({
        "resources": [
            {
                "uri": APP_URI,
                "name": "Clam Guard",
                "title": "Clam Guard",
                "description": "Live macOS lid state, power, thermal pressure, performance throttling, display guard, and built-in brightness controls.",
                "mimeType": APP_MIME,
                "_meta": {
                    "ui": { "prefersBorder": false }
                }
            }
        ]
    })
}

pub fn read_resource_json<P: ProbeBackend + 'static, D: DisplayBackend + 'static>(
    uri: &str,
    engine: &Arc<TelemetryEngine<P, D>>,
    html_loader: &HtmlLoader,
) -> Result<Value, String> {
    if uri != APP_URI {
        return Err(format!("Unknown resource URI: {uri}"));
    }
    let template = html_loader.load();
    let collected = engine.collect_swr();
    let mut boot_val = serde_json::to_value(&*collected.snapshot).unwrap_or_else(|_| json!({}));
    if let Some(obj) = boot_val.as_object_mut() {
        obj.insert("unchanged".into(), json!(false));
        obj.insert("serverMs".into(), json!(collected.server_ms));
        obj.insert("fromCache".into(), json!(collected.from_cache));
        obj.insert("stale".into(), json!(collected.stale));
        obj.insert("bootTs".into(), json!(now_epoch_ms() as u64));
        obj.insert("serverVersion".into(), json!(SERVER_VERSION));
    }
    let boot_script = format!(
        "window.__MAC_CLAMSHELL_BOOT__={};",
        serialize_boot_data(&boot_val)
    );
    let html = template.render_with_boot(&boot_script);

    Ok(json!({
        "contents": [
            {
                "uri": APP_URI,
                "mimeType": APP_MIME,
                "text": html,
                "_meta": {
                    "ui": { "prefersBorder": false }
                }
            }
        ]
    }))
}

pub fn is_tool_allowed(name: &str, apps_capable: bool) -> bool {
    match name {
        "clamshell_panel" | "clamshell_set_brightness" | "clamshell_lock_screen" => true,
        "clamshell_refresh" | "clamshell_configure" => apps_capable,
        _ => false,
    }
}

pub fn list_tools_json(apps_capable: bool) -> Value {
    let mut result = json!({
        "tools": [
            {
                "name": "clamshell_panel",
                "title": "Clam Guard",
                "description": "Open the Clam Guard live dashboard showing macOS lid state, power/battery, thermal pressure, read-only fan telemetry, built-in display brightness, display guard status, CPU/memory load, and active throttling profile.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "fresh": {
                            "type": "boolean",
                            "description": "Bypass short-lived telemetry cache and probe macOS immediately."
                        }
                    },
                    "additionalProperties": false
                },
                "_meta": {
                    "ui": { "resourceUri": APP_URI },
                    "com.google.antigravity/ui": {
                        "entrypoints": [
                            { "type": "global", "title": "Clam Guard" },
                            { "type": "aux_pane", "title": "Clam Guard" }
                        ]
                    }
                }
            },
            {
                "name": "clamshell_refresh",
                "title": "Refresh Clamshell Telemetry",
                "description": "Fetch fresh macOS lid, power, thermal pressure, fan readings, display brightness, guard status, and policy telemetry. Pass ifHash to receive a minimal { unchanged: true } payload when state has not changed.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "ifHash": {
                            "type": "string",
                            "maxLength": 64,
                            "description": "Previous telemetry hash for zero-overhead ETag deduplication."
                        },
                        "force": {
                            "type": "boolean",
                            "description": "Bypass short-lived telemetry cache and probe macOS immediately."
                        },
                        "fresh": {
                            "type": "boolean",
                            "description": "Alias for force: bypass short-lived telemetry cache and probe macOS immediately."
                        }
                    },
                    "additionalProperties": false
                },
                "_meta": {
                    "ui": { "visibility": ["app"] }
                }
            },
            {
                "name": "clamshell_configure",
                "title": "Configure Clamshell Policy & Guard",
                "description": "Persist performance mode override, max_jobs cap, closed-AC default profile, display guard enable/pause toggle, thermal brightness cap, or language preference and return updated telemetry.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "modeOverride": {
                            "type": "string",
                            "enum": ["auto", "eco", "utility", "strict", "normal"],
                            "description": "Performance profile override (auto follows live lid, power, and thermal pressure)."
                        },
                        "maxJobsOverride": {
                            "type": "integer",
                            "minimum": 0,
                            "maximum": 64,
                            "description": "Explicit parallel job limit override (0 restores automatic profile default)."
                        },
                        "acClosedProfile": {
                            "type": "string",
                            "enum": ["utility", "eco"],
                            "description": "Default profile used when the lid is closed on AC power."
                        },
                        "guardEnabled": {
                            "type": "boolean",
                            "description": "Enable or pause the closed-lid display backlight and thermal guard."
                        },
                        "thermalBrightCapPct": {
                            "type": "integer",
                            "minimum": 0,
                            "maximum": 100,
                            "description": "Optional open-lid brightness cap (1-100%) applied under serious/critical thermal pressure; 0 disables."
                        },
                        "lang": {
                            "type": "string",
                            "enum": ["auto", "en", "zh-CN"],
                            "description": "Preferred UI and CLI language override (auto, en, or zh-CN)."
                        },
                        "pollIntervalSec": {
                            "type": "integer",
                            "minimum": 0,
                            "maximum": 300,
                            "description": "Foreground panel refresh interval in seconds (0 uses adaptive auto polling)."
                        },
                        "bgPollIntervalSec": {
                            "type": "integer",
                            "minimum": -1,
                            "maximum": 3600,
                            "description": "Background panel refresh interval in seconds (0 uses adaptive auto polling, -1 pauses background refresh)."
                        }
                    },
                    "additionalProperties": false
                },
                "_meta": {
                    "ui": { "visibility": ["app"] }
                }
            },
            {
                "name": "clamshell_set_brightness",
                "title": "Set Built-in Display Brightness",
                "description": "Adjust MacBook built-in display brightness (0-100%) immediately when the lid is open and the display is awake. Otherwise saves the wake-restore target. Returns an error on desktop Macs without a built-in display.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "percent": {
                            "type": "number",
                            "minimum": 0,
                            "maximum": 100,
                            "description": "Target built-in display brightness percentage (0 to 100)."
                        }
                    },
                    "required": ["percent"],
                    "additionalProperties": false
                }
            },
            {
                "name": "clamshell_lock_screen",
                "title": "Lock Mac Screen",
                "description": "Lock the macOS screen immediately without putting the Mac to sleep, keeping background builds and AI agents running. Uses native SACLockScreenImmediate with CGSession fallback. The pmset fallback requires a verified macOS session lock.",
                "inputSchema": {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                }
            }
        ]
    });
    if let Some(tools) = result["tools"].as_array_mut() {
        tools.retain(|tool| {
            tool["name"]
                .as_str()
                .is_some_and(|name| is_tool_allowed(name, apps_capable))
        });
    }
    result
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RefreshArgs {
    #[serde(default, alias = "if_hash")]
    if_hash: Option<String>,
    #[serde(default)]
    force: Option<bool>,
    #[serde(default)]
    fresh: Option<bool>,
}

fn tool_error(lang: Lang, kind: &str, detail: impl Into<String>) -> Value {
    let msg = match (lang, kind) {
        (Lang::ZhCn, "no_builtin_display") => "这台 Mac 没有内建屏幕。",
        (Lang::En, "no_builtin_display") => "This Mac has no built-in screen.",
        (Lang::ZhCn, "invalid_brightness") => "亮度需在 0 到 100 之间。",
        (Lang::En, "invalid_brightness") => "Brightness must be between 0 and 100.",
        (Lang::ZhCn, "config_failed") => "设置保存失败。",
        (Lang::En, "config_failed") => "Couldn't save settings.",
        (Lang::ZhCn, "brightness_failed") => "亮度调节失败。",
        (Lang::En, "brightness_failed") => "Couldn't change brightness.",
        (Lang::ZhCn, "lock_failed") => "锁屏失败。",
        (Lang::En, "lock_failed") => "Couldn't lock the screen.",
        (Lang::ZhCn, "unknown_tool") => "不支持的操作。",
        (Lang::En, "unknown_tool") => "Unknown action.",
        (Lang::ZhCn, _) => "请求参数有误。",
        (Lang::En, _) => "Invalid request.",
    };
    json!({
        "isError": true,
        "content": [{ "type": "text", "text": msg }],
        "structuredContent": {
            "errorKind": kind,
            "errorDetail": detail.into()
        }
    })
}

pub fn call_tool_json<P: ProbeBackend + 'static, D: DisplayBackend + 'static>(
    name: &str,
    args: &Value,
    engine: &Arc<TelemetryEngine<P, D>>,
) -> Value {
    match name {
        "clamshell_panel" => {
            let fresh = args.get("fresh").and_then(|v| v.as_bool()).unwrap_or(false);
            let collected = engine.collect(fresh);
            let mut sc = serde_json::to_value(&*collected.snapshot).unwrap_or_else(|_| json!({}));
            if let Some(obj) = sc.as_object_mut() {
                obj.insert("unchanged".into(), json!(false));
                obj.insert("serverMs".into(), json!(collected.server_ms));
                obj.insert("fromCache".into(), json!(collected.from_cache));
                obj.insert("stale".into(), json!(collected.stale));
            }
            json!({
                "content": [{ "type": "text", "text": summarize_for_model(&collected.snapshot) }],
                "structuredContent": sc
            })
        }
        "clamshell_refresh" => {
            let parsed: RefreshArgs = match serde_json::from_value(args.clone()) {
                Ok(p) => p,
                Err(e) => {
                    return tool_error(
                        engine.detect_lang(),
                        "invalid_args",
                        format!("Invalid refresh arguments: {e}"),
                    );
                }
            };
            if let Some(ref h) = parsed.if_hash {
                if h.chars().count() > 64 {
                    return tool_error(
                        engine.detect_lang(),
                        "invalid_args",
                        "ifHash must be a string with maxLength 64",
                    );
                }
            }
            let force = parsed.force.unwrap_or(false) || parsed.fresh.unwrap_or(false);
            let (unchanged, sc, snap) = engine.refresh_json(parsed.if_hash.as_deref(), force);
            let text = if unchanged {
                "unchanged".to_string()
            } else {
                summarize_for_model(&snap)
            };
            json!({
                "content": [{ "type": "text", "text": text }],
                "structuredContent": sc
            })
        }
        "clamshell_configure" => {
            let patch: SettingsPatch = match serde_json::from_value(args.clone()) {
                Ok(p) => p,
                Err(e) => {
                    return tool_error(
                        engine.detect_lang(),
                        "invalid_args",
                        format!("Invalid configuration arguments: {e}"),
                    );
                }
            };
            match engine.configure(&patch) {
                Ok(_) => {
                    let collected = engine.collect(true);
                    let mut sc =
                        serde_json::to_value(&*collected.snapshot).unwrap_or_else(|_| json!({}));
                    if let Some(obj) = sc.as_object_mut() {
                        obj.insert("unchanged".into(), json!(false));
                        obj.insert("serverMs".into(), json!(collected.server_ms));
                        obj.insert("fromCache".into(), json!(collected.from_cache));
                        obj.insert("stale".into(), json!(collected.stale));
                    }
                    json!({
                        "content": [{ "type": "text", "text": summarize_for_model(&collected.snapshot) }],
                        "structuredContent": sc
                    })
                }
                Err(err) => tool_error(engine.detect_lang(), "config_failed", err),
            }
        }
        "clamshell_set_brightness" => {
            if let Some(obj) = args.as_object() {
                if let Some(unknown) = obj.keys().find(|k| k.as_str() != "percent") {
                    return tool_error(
                        engine.detect_lang(),
                        "invalid_args",
                        format!("Invalid brightness arguments: unknown field `{unknown}`"),
                    );
                }
            }
            let Some(raw_pct) = args.get("percent").and_then(|v| v.as_f64()) else {
                return tool_error(
                    engine.detect_lang(),
                    "invalid_brightness",
                    "percent must be a finite number between 0 and 100",
                );
            };
            let clamped = match clamp_percent(raw_pct) {
                Ok(v) => v,
                Err(err) => {
                    return tool_error(engine.detect_lang(), "invalid_brightness", err);
                }
            };
            let t0 = Instant::now();
            match engine.set_brightness(clamped as f64, None) {
                Ok(action) => {
                    if action.mode == "unavailable" {
                        return tool_error(
                            engine.detect_lang(),
                            "no_builtin_display",
                            "no built-in display detected on this Mac",
                        );
                    }
                    let mut collected = engine.collect(true);
                    collected.server_ms = t0.elapsed().as_millis() as u64;
                    let lang = parse_lang_tag(&collected.snapshot.locale).unwrap_or(Lang::En);
                    let mut sc =
                        serde_json::to_value(&*collected.snapshot).unwrap_or_else(|_| json!({}));
                    if let Some(obj) = sc.as_object_mut() {
                        obj.insert("unchanged".into(), json!(false));
                        obj.insert("serverMs".into(), json!(collected.server_ms));
                        obj.insert("fromCache".into(), json!(collected.from_cache));
                        obj.insert("stale".into(), json!(collected.stale));
                        obj.insert(
                            "brightnessAction".into(),
                            serde_json::to_value(&action).unwrap_or_else(|_| json!({})),
                        );
                    }
                    let note = match (lang, action.mode.as_str()) {
                        (Lang::ZhCn, "saved_target") => {
                            format!("屏幕唤醒后亮度恢复到 {}%。", action.saved_percent)
                        }
                        (Lang::ZhCn, _) => {
                            format!("亮度已设为 {}%。", action.percent.unwrap_or(clamped))
                        }
                        (Lang::En, "saved_target") => format!(
                            "Brightness will go back to {}% when the screen wakes.",
                            action.saved_percent
                        ),
                        (Lang::En, _) => {
                            format!("Brightness set to {}%.", action.percent.unwrap_or(clamped))
                        }
                    };
                    json!({
                        "content": [{ "type": "text", "text": format!("{note}\n{}", summarize_for_model(&collected.snapshot)) }],
                        "structuredContent": sc
                    })
                }
                Err(err) => {
                    let kind = if err.contains("no built-in display") {
                        "no_builtin_display"
                    } else {
                        "brightness_failed"
                    };
                    tool_error(engine.detect_lang(), kind, err)
                }
            }
        }
        "clamshell_lock_screen" => match engine.lock_screen() {
            Ok((outcome, locked_at_ms, server_ms)) => {
                let method = outcome.method;
                let verified = outcome.verified;
                let status = if verified { "verified" } else { "submitted" };
                let text = match (engine.detect_lang(), verified) {
                    (Lang::ZhCn, true) => "已锁屏，Mac 保持唤醒，后台任务照常运行。".to_string(),
                    (Lang::ZhCn, false) => {
                        "已发送锁屏，但没能确认是否锁上。Mac 保持唤醒。".to_string()
                    }
                    (Lang::En, true) => {
                        "Screen locked. Your Mac stays awake for background tasks.".to_string()
                    }
                    (Lang::En, false) => {
                        "Lock sent, but couldn't confirm it. Your Mac stays awake.".to_string()
                    }
                };
                json!({
                    "content": [{ "type": "text", "text": text }],
                    "structuredContent": {
                        "ok": true,
                        "method": method,
                        "verified": verified,
                        "status": status,
                        "locked_at_ms": locked_at_ms,
                        "serverMs": server_ms
                    }
                })
            }
            Err(err) => tool_error(engine.detect_lang(), "lock_failed", err),
        },
        other => tool_error(
            engine.detect_lang(),
            "unknown_tool",
            format!("Unknown tool: {other}"),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_tool_names_stay_within_64_chars_and_errors_are_localized() {
        let tools = list_tools_json(true)["tools"].as_array().unwrap().clone();
        assert_eq!(tools.len(), 5);
        for tool in &tools {
            let name = tool["name"].as_str().unwrap();
            assert!(
                name.len() <= 64,
                "tool name {name} exceeds 64 chars ({})",
                name.len()
            );
        }
        let zh_err = tool_error(Lang::ZhCn, "lock_failed", "raw stderr");
        assert_eq!(zh_err["isError"], true);
        assert_eq!(zh_err["structuredContent"]["errorKind"], "lock_failed");
        assert_eq!(zh_err["structuredContent"]["errorDetail"], "raw stderr");
        assert_eq!(zh_err["content"][0]["text"], "锁屏失败。");
    }

    #[test]
    fn html_loader_rejects_symlinks_and_oversized_files() {
        let dir =
            std::env::temp_dir().join(format!("mac-clamshell-html-loader-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let real_html = dir.join("real.html");
        fs::write(&real_html, "<html>custom/*__MAC_CLAMSHELL_BOOT__*/</html>").unwrap();
        let sym_html = dir.join("sym.html");
        std::os::unix::fs::symlink(&real_html, &sym_html).unwrap();

        let loader_sym = HtmlLoader::new(Some(sym_html));
        let rendered_sym = loader_sym.load().render_with_boot("boot();");
        assert!(!rendered_sym.contains("<html>custom"));

        let huge_html = dir.join("huge.html");
        let huge = format!(
            "<html>{}/*__MAC_CLAMSHELL_BOOT__*/</html>",
            "x".repeat(MAX_PANEL_HTML_BYTES + 128)
        );
        fs::write(&huge_html, huge).unwrap();
        let loader_huge = HtmlLoader::new(Some(huge_html));
        let rendered_huge = loader_huge.load().render_with_boot("boot();");
        assert!(!rendered_huge.contains(&"x".repeat(1024)));

        let _ = fs::remove_dir_all(&dir);
    }
}
