use crate::guard::{read_display_info, set_brightness_synced, BrightnessAction, DisplayInfo};
use crate::i18n::{detect_lang, parse_lang_tag, Lang};
use crate::launchagent::is_launchagent_active;
use crate::platform::display_ffi::{DisplayBackend, LockScreenOutcome};
use crate::platform::fan::{FanSensorSource, FanTelemetry};
use crate::platform::macos::{MemorySummary, ProbeBackend};
use crate::policy::{
    build_env_vars, compute_policy, compute_profile_jobs, format_lid, format_power,
    format_profile_name, format_thermal, CpuTopology, Policy, ProfileJobs,
};
use crate::state::{
    abbreviate_home, file_fingerprint, format_iso8601_utc, guard_state_path, load_guard_state,
    load_guard_state_opt, now_epoch_ms, settings_path, sha256_hex_16, try_read_settings,
    write_settings, DaemonLock, DisplayGuardSummary, FileFingerprint, Settings, SettingsPatch,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

pub const TELEMETRY_CACHE_TTL_MS: u64 = 1500;

fn lock_unpoisoned<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostTelemetry {
    pub hostname: String,
    pub chip: String,
    pub macos_version: String,
    pub uptime_seconds: u64,
    pub load_avg: [f64; 3],
    pub memory: MemorySummary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryPaths {
    pub settings_path: String,
    pub binary_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetrySnapshot {
    pub timestamp: String,
    pub locale: String,
    pub host: HostTelemetry,
    pub lid_state: String,
    pub clamshell_causes_sleep: String,
    pub power_source: String,
    pub battery_pct: Option<u32>,
    pub battery_detail: String,
    pub thermal_state: String,
    pub thermal_pressure: String,
    pub cpu_speed_limit_pct: Option<u32>,
    pub low_power_mode: String,
    pub cpu_topology: CpuTopology,
    pub settings: Settings,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings_error: Option<String>,
    pub policy: Policy,
    pub profile_jobs: ProfileJobs,
    pub env_vars: BTreeMap<String, String>,
    pub display: DisplayInfo,
    pub fan: FanTelemetry,
    pub display_guard: Option<DisplayGuardSummary>,
    pub guard_status: String,
    pub degraded: bool,
    pub paths: TelemetryPaths,
    pub hash: String,
}

#[derive(Debug, Clone)]
pub struct CollectedTelemetry {
    pub snapshot: Arc<TelemetrySnapshot>,
    pub server_ms: u64,
    pub from_cache: bool,
    pub stale: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnchangedPayload {
    pub unchanged: bool,
    pub hash: String,
    pub timestamp: String,
    pub server_ms: u64,
    pub from_cache: bool,
    pub stale: bool,
}

pub fn compute_telemetry_hash(s: &TelemetrySnapshot) -> String {
    let canonical = json!({
        "locale": s.locale,
        "host": {
            "hostname": s.host.hostname,
            "chip": s.host.chip,
            "macosVersion": s.host.macos_version,
            "uptimeMinutes": s.host.uptime_seconds / 60,
            "loadAvg": s.host.load_avg,
            "memory": s.host.memory,
        },
        "lidState": s.lid_state,
        "clamshellCausesSleep": s.clamshell_causes_sleep,
        "powerSource": s.power_source,
        "batteryPct": s.battery_pct,
        "batteryDetail": s.battery_detail,
        "thermalState": s.thermal_state,
        "thermalPressure": s.thermal_pressure,
        "cpuSpeedLimitPct": s.cpu_speed_limit_pct,
        "lowPowerMode": s.low_power_mode,
        "cpuTopology": s.cpu_topology,
        "settings": s.settings,
        "settingsError": s.settings_error,
        "policy": s.policy,
        "profileJobs": s.profile_jobs,
        "envVars": s.env_vars,
        "display": s.display,
        "fan": {
            "status": s.fan.status,
            "fans": s.fan.fans,
            "smcMode": s.fan.smc_mode,
            "controller": s.fan.controller,
            "externalManagers": s.fan.external_managers,
            "detectedMonitors": s.fan.detected_monitors,
            "ownershipMode": s.fan.ownership_mode,
            "readOnly": s.fan.read_only,
            "stale": s.fan.stale,
            "note": s.fan.note,
        },
        "displayGuard": s.display_guard,
        "guardStatus": s.guard_status,
        "degraded": s.degraded,
    });
    let bytes = serde_json::to_vec(&canonical).unwrap_or_default();
    sha256_hex_16(&bytes)
}

pub fn format_fan(fan: &FanTelemetry, lang: Lang) -> String {
    let readings = match (lang, fan.status.as_str()) {
        (Lang::ZhCn, "fanless") => "无风扇".to_string(),
        (Lang::En, "fanless") => "fanless".to_string(),
        (Lang::ZhCn, "unavailable") => "读不到风扇".to_string(),
        (Lang::En, "unavailable") => "can't read fans".to_string(),
        _ => fan
            .fans
            .iter()
            .map(|f| {
                let label = match (lang, f.label.as_str()) {
                    (Lang::ZhCn, "Left") => "左侧".to_string(),
                    (Lang::ZhCn, "Right") => "右侧".to_string(),
                    (Lang::ZhCn, _) => format!("风扇 {}", u16::from(f.id) + 1),
                    (Lang::En, label) => label.to_string(),
                };
                format!("{label} {} RPM", f.rpm)
            })
            .collect::<Vec<_>>()
            .join(", "),
    };
    let mode_desc = match (lang, fan.smc_mode.as_str()) {
        (Lang::ZhCn, "manual") => "SMC 手动",
        (Lang::ZhCn, "auto") => "SMC 自动",
        (Lang::ZhCn, "none") => "被动散热",
        (Lang::ZhCn, _) => "SMC 模式未知",
        (Lang::En, "manual") => "SMC manual",
        (Lang::En, "auto") => "SMC auto",
        (Lang::En, "none") => "passive",
        (Lang::En, _) => "SMC mode unknown",
    };
    let software = if !fan.external_managers.is_empty() {
        let joined = fan.external_managers.join(", ");
        match lang {
            Lang::ZhCn => format!("，检测到风扇控制软件：{joined}"),
            Lang::En => format!(", detected fan control: {joined}"),
        }
    } else if !fan.detected_monitors.is_empty() {
        let joined = fan.detected_monitors.join(", ");
        match lang {
            Lang::ZhCn => format!("，检测到监测软件：{joined}"),
            Lang::En => format!(", detected monitor: {joined}"),
        }
    } else {
        String::new()
    };
    match lang {
        Lang::ZhCn => format!("{readings}（只读，{mode_desc}{software}）"),
        Lang::En => format!("{readings} (read-only, {mode_desc}{software})"),
    }
}

pub fn summarize_for_model(s: &TelemetrySnapshot) -> String {
    let lang = parse_lang_tag(&s.locale).unwrap_or(Lang::En);
    let lid_label = format_lid(&s.lid_state, lang);
    let power_label = format_power(&s.power_source, s.battery_pct, lang);
    let therm_label = format_thermal(
        &s.thermal_state,
        &s.thermal_pressure,
        s.cpu_speed_limit_pct,
        lang,
    );
    let prof_label = format_profile_name(&s.policy.profile, lang);

    match lang {
        Lang::ZhCn => {
            let disp_desc = if s.display.available {
                if s.display.lid_closed || s.display.mode == "saved_target" {
                    let ext = if s.display.external_count > 0 {
                        format!("，外接 {} 台", s.display.external_count)
                    } else {
                        String::new()
                    };
                    let panel_state = if s.display.internal_offline {
                        "屏幕已关"
                    } else if s.display.confirmed_asleep {
                        "屏幕已熄"
                    } else {
                        "屏幕亮着"
                    };
                    format!(
                        "已合盖（{panel_state}{ext}），唤醒后恢复 {}%",
                        s.display.saved_percent.unwrap_or(20)
                    )
                } else if s.display.confirmed_asleep {
                    format!(
                        "屏幕已熄，唤醒后恢复 {}%",
                        s.display.saved_percent.or(s.display.percent).unwrap_or(20)
                    )
                } else {
                    format!("{}%（亮着）", s.display.percent.unwrap_or(0))
                }
            } else {
                "没有内建屏幕".to_string()
            };
            let guard_desc = match s.guard_status.as_str() {
                "protecting" => "保护中",
                "thermal_cap" => "高温降亮",
                "armed" => "运行中",
                "paused" => "已暂停",
                _ => "空闲",
            };
            [
                format!("Clam Guard（{} · {}）", s.host.hostname, s.host.chip),
                format!("- 机盖：{lid_label}，电源：{power_label}，温度：{therm_label}"),
                format!(
                    "- 当前模式：{prof_label}，最多 {} 个任务",
                    s.policy.max_jobs
                ),
                format!(
                    "- 系统负载：{:.2} / {:.2} / {:.2}，内存：{:.1}/{:.1} GB ({}%)",
                    s.host.load_avg[0],
                    s.host.load_avg[1],
                    s.host.load_avg[2],
                    s.host.memory.used_gb,
                    s.host.memory.total_gb,
                    s.host.memory.used_pct
                ),
                format!("- 风扇：{}", format_fan(&s.fan, lang)),
                format!("- 内建屏幕：{disp_desc}（守护：{guard_desc}）"),
            ]
            .join("\n")
        }
        Lang::En => {
            let disp_desc = if s.display.available {
                if s.display.lid_closed || s.display.mode == "saved_target" {
                    let ext = if s.display.external_count > 0 {
                        format!(", {} external", s.display.external_count)
                    } else {
                        String::new()
                    };
                    let panel_state = if s.display.internal_offline {
                        "screen off"
                    } else if s.display.confirmed_asleep {
                        "screen asleep"
                    } else {
                        "screen on"
                    };
                    format!(
                        "closed ({panel_state}{ext}), wakes at {}%",
                        s.display.saved_percent.unwrap_or(20)
                    )
                } else if s.display.confirmed_asleep {
                    format!(
                        "screen asleep, wakes at {}%",
                        s.display.saved_percent.or(s.display.percent).unwrap_or(20)
                    )
                } else {
                    format!("{}% (screen on)", s.display.percent.unwrap_or(0))
                }
            } else {
                "no built-in screen".to_string()
            };
            let guard_desc = match s.guard_status.as_str() {
                "protecting" => "protecting",
                "thermal_cap" => "dimmed for heat",
                "armed" => "on",
                "paused" => "paused",
                _ => "idle",
            };
            [
                format!("Clam Guard ({} · {})", s.host.hostname, s.host.chip),
                format!("- Lid: {lid_label}, Power: {power_label}, Heat: {therm_label}"),
                format!(
                    "- Current mode: {prof_label}, up to {} jobs",
                    s.policy.max_jobs
                ),
                format!(
                    "- Load Avg: {:.2} / {:.2} / {:.2}, Memory: {:.1}/{:.1} GB ({}%)",
                    s.host.load_avg[0],
                    s.host.load_avg[1],
                    s.host.load_avg[2],
                    s.host.memory.used_gb,
                    s.host.memory.total_gb,
                    s.host.memory.used_pct
                ),
                format!("- Fans: {}", format_fan(&s.fan, lang)),
                format!("- Built-in Screen: {disp_desc} (guard: {guard_desc})"),
            ]
            .join("\n")
        }
    }
}

struct CachedEntry {
    at: Instant,
    gen: u64,
    settings_fp: FileFingerprint,
    guard_fp: FileFingerprint,
    snapshot: Arc<TelemetrySnapshot>,
}

struct InFlightSlot {
    gen: u64,
    fresh: bool,
    result: Option<Arc<TelemetrySnapshot>>,
    aborted: bool,
}

struct LeaderCleanup<'a, P: ProbeBackend, D: DisplayBackend> {
    engine: &'a TelemetryEngine<P, D>,
    slot: Arc<(Mutex<InFlightSlot>, Condvar)>,
    completed: bool,
}

impl<P: ProbeBackend, D: DisplayBackend> Drop for LeaderCleanup<'_, P, D> {
    fn drop(&mut self) {
        if self.completed {
            return;
        }
        {
            let mut guard = lock_unpoisoned(&self.engine.state);
            if guard
                .in_flight
                .as_ref()
                .map(|s| Arc::ptr_eq(s, &self.slot))
                .unwrap_or(false)
            {
                guard.in_flight = None;
            }
        }
        let (lock, cvar) = &*self.slot;
        lock_unpoisoned(lock).aborted = true;
        cvar.notify_all();
    }
}

struct Coalescer {
    cache: Option<CachedEntry>,
    in_flight: Option<Arc<(Mutex<InFlightSlot>, Condvar)>>,
}

struct SettingsWatchState {
    last_fp: FileFingerprint,
    last_good: Settings,
    last_error: Option<String>,
}

pub struct TelemetryEngine<P: ProbeBackend, D: DisplayBackend> {
    data_dir: PathBuf,
    binary_path: String,
    probe: P,
    display: D,
    fan: Box<dyn FanSensorSource>,
    cache_ttl_ms: u64,
    settings_gen: AtomicU64,
    bg_guard_active: AtomicBool,
    swr_refreshing: AtomicBool,
    guard_wake: (Mutex<u64>, Condvar),
    settings_watch: Mutex<SettingsWatchState>,
    state: Mutex<Coalescer>,
}

impl<P: ProbeBackend, D: DisplayBackend> TelemetryEngine<P, D> {
    pub fn new(
        data_dir: PathBuf,
        binary_path: String,
        probe: P,
        display: D,
        fan: impl FanSensorSource + 'static,
    ) -> Self {
        Self::with_ttl(
            data_dir,
            binary_path,
            probe,
            display,
            fan,
            TELEMETRY_CACHE_TTL_MS,
        )
    }

    fn with_ttl(
        data_dir: PathBuf,
        binary_path: String,
        probe: P,
        display: D,
        fan: impl FanSensorSource + 'static,
        cache_ttl_ms: u64,
    ) -> Self {
        let init_fp = file_fingerprint(&settings_path(&data_dir));
        let (last_good, last_error) = match try_read_settings(&data_dir) {
            Ok(s) => (s, None),
            Err(e) => (Settings::default(), Some(e)),
        };
        Self {
            data_dir,
            binary_path,
            probe,
            display,
            fan: Box::new(fan),
            cache_ttl_ms,
            settings_gen: AtomicU64::new(0),
            bg_guard_active: AtomicBool::new(false),
            swr_refreshing: AtomicBool::new(false),
            guard_wake: (Mutex::new(0), Condvar::new()),
            settings_watch: Mutex::new(SettingsWatchState {
                last_fp: init_fp,
                last_good,
                last_error,
            }),
            state: Mutex::new(Coalescer {
                cache: None,
                in_flight: None,
            }),
        }
    }

    /// Non-destructive hot-reload of `settings.json` on `(mtime_ns, size, ino)` change.
    /// Fails closed on syntax/validation errors: preserves `last_good` and surfaces `settingsError`.
    pub fn reload_settings_if_changed(&self) -> (Settings, Option<String>) {
        let fp = file_fingerprint(&settings_path(&self.data_dir));
        let mut sw = lock_unpoisoned(&self.settings_watch);
        if fp != sw.last_fp {
            sw.last_fp = fp;
            match try_read_settings(&self.data_dir) {
                Ok(s) => {
                    sw.last_good = s;
                    sw.last_error = None;
                }
                Err(e) => {
                    sw.last_error = Some(e);
                }
            }
            self.settings_gen.fetch_add(1, Ordering::SeqCst);
        }
        (sw.last_good.clone(), sw.last_error.clone())
    }

    pub fn set_bg_guard_active(&self, active: bool) {
        self.bg_guard_active.store(active, Ordering::SeqCst);
        self.invalidate_cache();
    }

    pub fn notify_guard_wake(&self) {
        let (lock, cvar) = &self.guard_wake;
        let mut seq = lock_unpoisoned(lock);
        *seq = seq.wrapping_add(1);
        cvar.notify_all();
    }

    pub fn wait_guard_interval(&self, dur: Duration, stop: &AtomicBool) {
        if stop.load(Ordering::SeqCst) {
            return;
        }
        let (lock, cvar) = &self.guard_wake;
        let guard = lock_unpoisoned(lock);
        let cur = *guard;
        let _ = cvar.wait_timeout_while(guard, dur, |seq| {
            *seq == cur && !stop.load(Ordering::SeqCst)
        });
    }

    pub fn invalidate_cache(&self) {
        self.settings_gen.fetch_add(1, Ordering::SeqCst);
        let mut guard = lock_unpoisoned(&self.state);
        guard.cache = None;
    }

    pub fn prewarm(self: &Arc<Self>) {
        let _ = self.collect(true);
    }

    /// Persist settings and asynchronously wake any fallback guard loop.
    /// Does NOT run blocking hardware guard ticks or synchronous telemetry probes inside the mutation.
    pub fn configure(&self, patch: &SettingsPatch) -> Result<Settings, String> {
        let updated = write_settings(&self.data_dir, patch)
            .map_err(|e| format!("failed to write settings: {e}"))?;
        {
            let mut sw = lock_unpoisoned(&self.settings_watch);
            sw.last_fp = file_fingerprint(&settings_path(&self.data_dir));
            sw.last_good = updated.clone();
            sw.last_error = None;
        }
        if patch.guard_enabled.is_some() || patch.thermal_bright_cap_pct.is_some() {
            self.notify_guard_wake();
        }
        self.invalidate_cache();
        Ok(updated)
    }

    /// Apply user brightness safely under `FileLock` and invalidate cached telemetry.
    /// Callers sequence `collect(true)` separately so mutations never re-enter the coalescer.
    pub fn set_brightness(
        &self,
        percent: f64,
        lid_override: Option<bool>,
    ) -> Result<BrightnessAction, String> {
        let action = set_brightness_synced(
            &self.data_dir,
            percent,
            lid_override,
            &self.probe,
            &self.display,
        )?;
        self.invalidate_cache();
        Ok(action)
    }

    pub fn detect_lang(&self) -> Lang {
        let (settings, _) = self.reload_settings_if_changed();
        detect_lang(settings.lang.as_deref())
    }

    pub fn lock_screen(&self) -> Result<(LockScreenOutcome, u64, u64), String> {
        let t0 = Instant::now();
        let outcome = self.display.lock_screen_now()?;
        let locked_at_ms = now_epoch_ms() as u64;
        let server_ms = t0.elapsed().as_millis() as u64;
        Ok((outcome, locked_at_ms, server_ms))
    }

    fn disk_fingerprints(&self) -> (FileFingerprint, FileFingerprint) {
        (
            file_fingerprint(&settings_path(&self.data_dir)),
            file_fingerprint(&guard_state_path(&self.data_dir)),
        )
    }

    fn run_leader(
        &self,
        req_gen: u64,
        force: bool,
        slot: Arc<(Mutex<InFlightSlot>, Condvar)>,
    ) -> Arc<TelemetrySnapshot> {
        let mut cleanup = LeaderCleanup {
            engine: self,
            slot: Arc::clone(&slot),
            completed: false,
        };
        let (settings_fp, guard_fp) = self.disk_fingerprints();
        let snapshot = Arc::new(self.probe_snapshot(force));
        {
            let mut guard = lock_unpoisoned(&self.state);
            // Generation-fenced cache update: never overwrite cache if settings/brightness changed!
            if self.settings_gen.load(Ordering::SeqCst) == req_gen {
                guard.cache = Some(CachedEntry {
                    at: Instant::now(),
                    gen: req_gen,
                    settings_fp,
                    guard_fp,
                    snapshot: Arc::clone(&snapshot),
                });
            }
            if guard
                .in_flight
                .as_ref()
                .map(|s| Arc::ptr_eq(s, &slot))
                .unwrap_or(false)
            {
                guard.in_flight = None;
            }
        }
        let (lock, cvar) = &*slot;
        lock_unpoisoned(lock).result = Some(Arc::clone(&snapshot));
        cleanup.completed = true;
        cvar.notify_all();
        snapshot
    }

    /// Collect live or cached telemetry with strict single-flight coalescing, generation fencing,
    /// and passive disk fingerprint observation for external guard daemons.
    pub fn collect(&self, force: bool) -> CollectedTelemetry {
        let t0 = Instant::now();
        let _ = self.reload_settings_if_changed();
        let req_gen = self.settings_gen.load(Ordering::SeqCst);
        let cur_fps = if !force {
            Some(self.disk_fingerprints())
        } else {
            None
        };

        let follower_slot: Option<Arc<(Mutex<InFlightSlot>, Condvar)>>;
        let leader_slot: Option<Arc<(Mutex<InFlightSlot>, Condvar)>>;

        {
            let mut guard = lock_unpoisoned(&self.state);
            if let Some((settings_fp, guard_fp)) = cur_fps {
                if let Some(ref c) = guard.cache {
                    if c.gen == req_gen
                        && c.settings_fp == settings_fp
                        && c.guard_fp == guard_fp
                        && (c.at.elapsed().as_millis() as u64) < self.cache_ttl_ms
                    {
                        return CollectedTelemetry {
                            snapshot: Arc::clone(&c.snapshot),
                            server_ms: 0,
                            from_cache: true,
                            stale: false,
                        };
                    }
                }
            }

            if let Some(ref existing) = guard.in_flight {
                let slot_gen = lock_unpoisoned(&existing.0).gen;
                if slot_gen == req_gen {
                    follower_slot = Some(Arc::clone(existing));
                    leader_slot = None;
                } else {
                    let slot = Arc::new((
                        Mutex::new(InFlightSlot {
                            gen: req_gen,
                            fresh: force,
                            result: None,
                            aborted: false,
                        }),
                        Condvar::new(),
                    ));
                    guard.in_flight = Some(Arc::clone(&slot));
                    follower_slot = None;
                    leader_slot = Some(slot);
                }
            } else {
                let slot = Arc::new((
                    Mutex::new(InFlightSlot {
                        gen: req_gen,
                        fresh: force,
                        result: None,
                        aborted: false,
                    }),
                    Condvar::new(),
                ));
                guard.in_flight = Some(Arc::clone(&slot));
                follower_slot = None;
                leader_slot = Some(slot);
            }
        }

        if let Some(slot) = follower_slot {
            let (lock, cvar) = &*slot;
            let mut st = lock_unpoisoned(lock);
            while st.result.is_none() && !st.aborted {
                st = cvar.wait(st).unwrap_or_else(|e| e.into_inner());
            }
            if force && !st.fresh {
                // A regular refresh may have reused per-source caches.
                drop(st);
                return self.collect(true);
            }
            if let Some(ref snap) = st.result {
                return CollectedTelemetry {
                    snapshot: Arc::clone(snap),
                    server_ms: t0.elapsed().as_millis() as u64,
                    from_cache: false,
                    stale: false,
                };
            }
            drop(st);
            return CollectedTelemetry {
                snapshot: Arc::new(self.probe_snapshot(force)),
                server_ms: t0.elapsed().as_millis() as u64,
                from_cache: false,
                stale: false,
            };
        }

        let snapshot = if let Some(slot) = leader_slot {
            self.run_leader(req_gen, force, slot)
        } else {
            Arc::new(self.probe_snapshot(force))
        };

        CollectedTelemetry {
            snapshot,
            server_ms: t0.elapsed().as_millis() as u64,
            from_cache: false,
            stale: false,
        }
    }

    /// Non-blocking stale-while-revalidate telemetry read for `<2ms` SSR boot.
    /// Returns cached telemetry immediately if present (spawning a background refresh if stale
    /// or fingerprints drifted), and probes synchronously only when completely cold.
    pub fn collect_swr(self: &Arc<Self>) -> CollectedTelemetry
    where
        P: 'static,
        D: 'static,
    {
        let _ = self.reload_settings_if_changed();
        let req_gen = self.settings_gen.load(Ordering::SeqCst);
        let (settings_fp, guard_fp) = self.disk_fingerprints();

        let cached_entry = {
            let guard = lock_unpoisoned(&self.state);
            if let Some(ref c) = guard.cache {
                let fresh = c.gen == req_gen
                    && c.settings_fp == settings_fp
                    && c.guard_fp == guard_fp
                    && (c.at.elapsed().as_millis() as u64) < self.cache_ttl_ms;
                Some((Arc::clone(&c.snapshot), fresh, guard.in_flight.is_none()))
            } else {
                None
            }
        };

        match cached_entry {
            Some((snapshot, true, _)) => CollectedTelemetry {
                snapshot,
                server_ms: 0,
                from_cache: true,
                stale: false,
            },
            Some((snapshot, false, no_in_flight)) => {
                if no_in_flight
                    && self
                        .swr_refreshing
                        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                        .is_ok()
                {
                    let engine = Arc::clone(self);
                    if std::thread::Builder::new()
                        .name("clamshell-swr".into())
                        .spawn(move || {
                            struct Reset<'a>(&'a AtomicBool);
                            impl Drop for Reset<'_> {
                                fn drop(&mut self) {
                                    self.0.store(false, Ordering::SeqCst);
                                }
                            }
                            let _reset = Reset(&engine.swr_refreshing);
                            let _ = engine.collect(false);
                        })
                        .is_err()
                    {
                        self.swr_refreshing.store(false, Ordering::SeqCst);
                    }
                }
                CollectedTelemetry {
                    snapshot,
                    server_ms: 0,
                    from_cache: true,
                    stale: true,
                }
            }
            None => self.collect(false),
        }
    }

    pub fn refresh_json(
        &self,
        if_hash: Option<&str>,
        force: bool,
    ) -> (bool, Value, Arc<TelemetrySnapshot>) {
        let collected = self.collect(force);
        let clean_hash = if_hash.map(str::trim).unwrap_or("");
        if !clean_hash.is_empty() && clean_hash == collected.snapshot.hash {
            let payload = serde_json::to_value(UnchangedPayload {
                unchanged: true,
                hash: collected.snapshot.hash.clone(),
                timestamp: collected.snapshot.timestamp.clone(),
                server_ms: collected.server_ms,
                from_cache: collected.from_cache,
                stale: collected.stale,
            })
            .unwrap_or_else(|_| json!({ "unchanged": true }));
            return (true, payload, collected.snapshot);
        }

        let mut val = serde_json::to_value(&*collected.snapshot).unwrap_or_else(|_| json!({}));
        if let Some(obj) = val.as_object_mut() {
            obj.insert("unchanged".into(), json!(false));
            obj.insert("serverMs".into(), json!(collected.server_ms));
            obj.insert("fromCache".into(), json!(collected.from_cache));
            obj.insert("stale".into(), json!(collected.stale));
        }
        (false, val, collected.snapshot)
    }

    fn probe_snapshot(&self, force: bool) -> TelemetrySnapshot {
        let (settings, settings_error) = self.reload_settings_if_changed();
        let lang = detect_lang(settings.lang.as_deref());
        let guard_opt = load_guard_state_opt(&self.data_dir);
        let guard_for_disp = guard_opt
            .clone()
            .unwrap_or_else(|| load_guard_state(&self.data_dir));
        let host_info = self.probe.static_host();
        let hw = if force {
            self.probe.probe_hardware_fresh()
        } else {
            self.probe.probe_hardware()
        };
        let display = read_display_info(&self.display, &hw.lid_state, &guard_for_disp);
        let display_guard = guard_opt.as_ref().map(DisplayGuardSummary::from);

        let runner_active = self.bg_guard_active.load(Ordering::SeqCst)
            || is_launchagent_active()
            || DaemonLock::is_active(&self.data_dir);
        let effective_thermal_cap = guard_for_disp.machine.thermal_capped
            && !guard_for_disp.user_intent.user_override_thermal;
        let guard_status = if !settings.guard_enabled {
            "paused"
        } else if runner_active && hw.lid_state == "closed" {
            "protecting"
        } else if runner_active && effective_thermal_cap {
            "thermal_cap"
        } else if runner_active {
            "armed"
        } else {
            "idle"
        }
        .to_string();

        let policy = compute_policy(
            &hw.lid_state,
            &hw.power_source,
            hw.battery_pct,
            &hw.thermal_state,
            &host_info.cpu_topology,
            &settings,
        );
        let profile_jobs = compute_profile_jobs(&host_info.cpu_topology, hw.battery_pct);
        let env_vars = build_env_vars(&policy);

        let mut snap = TelemetrySnapshot {
            timestamp: format_iso8601_utc(now_epoch_ms()),
            locale: lang.code().to_string(),
            host: HostTelemetry {
                hostname: host_info.hostname,
                chip: host_info.chip,
                macos_version: host_info.macos_version,
                uptime_seconds: hw.uptime_seconds,
                load_avg: hw.load_avg,
                memory: hw.memory,
            },
            lid_state: hw.lid_state,
            clamshell_causes_sleep: hw.clamshell_causes_sleep,
            power_source: hw.power_source,
            battery_pct: hw.battery_pct,
            battery_detail: hw.battery_detail,
            thermal_state: hw.thermal_state,
            thermal_pressure: hw.thermal_pressure,
            cpu_speed_limit_pct: hw.cpu_speed_limit_pct,
            low_power_mode: hw.low_power_mode,
            cpu_topology: host_info.cpu_topology,
            settings,
            settings_error,
            policy,
            profile_jobs,
            env_vars,
            display,
            fan: self.fan.sample(force),
            display_guard,
            guard_status,
            degraded: hw.degraded,
            paths: TelemetryPaths {
                settings_path: abbreviate_home(&settings_path(&self.data_dir)),
                binary_path: abbreviate_home(Path::new(&self.binary_path)),
            },
            hash: String::new(),
        };
        snap.hash = compute_telemetry_hash(&snap);
        snap
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::fan::TestFanSensor;
    use crate::platform::macos::{HardwareProbe, StaticHostInfo};
    use std::sync::atomic::AtomicUsize;

    struct FakeProbe {
        delay_ms: u64,
        calls: Arc<AtomicUsize>,
        uptime: Arc<AtomicU64>,
        lid_closed: Arc<AtomicBool>,
    }

    impl ProbeBackend for FakeProbe {
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
            Some(self.lid_closed.load(Ordering::Relaxed))
        }
        fn probe_hardware(&self) -> HardwareProbe {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if self.delay_ms > 0 {
                std::thread::sleep(Duration::from_millis(self.delay_ms));
            }
            let closed = self.lid_closed.load(Ordering::Relaxed);
            HardwareProbe {
                lid_state: if closed { "closed" } else { "open" }.into(),
                clamshell_causes_sleep: "no".into(),
                power_source: "battery".into(),
                battery_pct: Some(85),
                battery_detail: "-InternalBattery-0\t85%; discharging".into(),
                thermal_state: "ok".into(),
                thermal_pressure: "nominal".into(),
                cpu_speed_limit_pct: None,
                low_power_mode: "0".into(),
                memory: MemorySummary {
                    total_gb: 16.0,
                    used_gb: 8.5,
                    compressed_gb: 1.2,
                    used_pct: 53,
                },
                load_avg: [1.5, 1.25, 1.1],
                uptime_seconds: self.uptime.load(Ordering::Relaxed),
                degraded: false,
            }
        }
    }

    struct FakeDisplay {
        brightness: Arc<Mutex<f32>>,
    }

    impl DisplayBackend for FakeDisplay {
        fn get_displays(&self) -> (Vec<u32>, Vec<u32>) {
            (vec![1], vec![])
        }
        fn is_asleep(&self, _id: u32) -> Option<bool> {
            Some(false)
        }
        fn get_brightness(&self, _id: u32) -> Option<f32> {
            Some(*self.brightness.lock().unwrap())
        }
        fn set_brightness(&self, _id: u32, level: f32) -> bool {
            *self.brightness.lock().unwrap() = level;
            true
        }
        fn sleep_display_now(&self) -> bool {
            true
        }
        fn lock_screen_now(&self) -> Result<LockScreenOutcome, String> {
            Ok(LockScreenOutcome {
                method: "mock",
                verified: true,
            })
        }
    }

    #[test]
    fn fan_readings_change_hash_but_resampling_identical_values_does_not() {
        struct MutableFan(Arc<Mutex<FanTelemetry>>);
        impl FanSensorSource for MutableFan {
            fn sample(&self, fresh: bool) -> FanTelemetry {
                let mut fan = self.0.lock().unwrap();
                if fresh {
                    fan.sampled_at_ms += 1;
                }
                fan.clone()
            }
        }
        let fan = Arc::new(Mutex::new(TestFanSensor("active:2140,2210").sample(false)));
        let dir = std::env::temp_dir().join(format!("clamshell-fan-hash-{}", std::process::id()));
        let engine = TelemetryEngine::new(
            dir,
            "mac-clamshell-mcp".into(),
            FakeProbe {
                delay_ms: 0,
                calls: Arc::new(AtomicUsize::new(0)),
                uptime: Arc::new(AtomicU64::new(3600)),
                lid_closed: Arc::new(AtomicBool::new(false)),
            },
            FakeDisplay {
                brightness: Arc::new(Mutex::new(0.7)),
            },
            MutableFan(Arc::clone(&fan)),
        );
        let initial = engine.collect(false);
        assert_eq!(initial.snapshot.fan.fans[0].rpm, 2140);
        let fresh = engine.collect(true);
        assert!(fresh.snapshot.fan.sampled_at_ms > initial.snapshot.fan.sampled_at_ms);
        assert_eq!(fresh.snapshot.hash, initial.snapshot.hash);

        fan.lock().unwrap().fans[0].rpm = 2400;
        assert!(engine.collect(false).from_cache);
        let (unchanged, payload, snapshot) = engine.refresh_json(Some(&fresh.snapshot.hash), true);
        assert!(!unchanged);
        assert_ne!(fresh.snapshot.hash, snapshot.hash);
        assert_eq!(payload["fan"]["fans"][0]["rpm"], 2400);
    }

    #[test]
    fn etag_dedup_single_flight_generation_fencing_and_bg_guard() {
        let dir =
            std::env::temp_dir().join(format!("mac-clamshell-tel-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let calls = Arc::new(AtomicUsize::new(0));
        let uptime = Arc::new(AtomicU64::new(3600));
        let lid_closed = Arc::new(AtomicBool::new(false));
        let bright = Arc::new(Mutex::new(0.70f32));

        let engine = Arc::new(TelemetryEngine::with_ttl(
            dir.clone(),
            "mac-clamshell-mcp".into(),
            FakeProbe {
                delay_ms: 40,
                calls: Arc::clone(&calls),
                uptime: Arc::clone(&uptime),
                lid_closed: Arc::clone(&lid_closed),
            },
            FakeDisplay {
                brightness: Arc::clone(&bright),
            },
            TestFanSensor("active:2140,2210"),
            2500,
        ));
        engine.set_bg_guard_active(true);

        // 1. 8 concurrent force=true calls coalesce into EXACTLY 1 probe!
        let mut handles = Vec::new();
        for _ in 0..8 {
            let e = Arc::clone(&engine);
            handles.push(std::thread::spawn(move || e.collect(true)));
        }
        let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(results[0].snapshot.guard_status, "armed");
        let h0 = results[0].snapshot.hash.clone();
        assert_eq!(h0.len(), 16);

        // 2. Sub-minute uptime tick + forced refresh still returns unchanged: true
        uptime.store(3615, Ordering::Relaxed);
        let (unchanged, payload, _) = engine.refresh_json(Some(&h0), true);
        assert!(unchanged);
        assert_eq!(payload["unchanged"], true);
        assert!(payload.get("host").is_none());

        // 3. Brightness update changes hash and returns live brightness (sequenced separately from collect)
        let act = engine.set_brightness(45.0, Some(false)).unwrap();
        let upd = engine.collect(true);
        assert!(act.applied);
        assert_eq!(upd.snapshot.display.percent, Some(45));
        assert_eq!(upd.snapshot.profile_jobs.normal, 8);
        assert_eq!(upd.snapshot.profile_jobs.utility, 2);
        assert_eq!(upd.snapshot.profile_jobs.eco, 2);
        assert_eq!(upd.snapshot.profile_jobs.strict, 1);
        assert_ne!(upd.snapshot.hash, h0);

        // 4. External/standalone guard records a closed lid without writing brightness; TelemetryEngine observes disk
        // fingerprint change passively without push-coupling from the guard daemon!
        lid_closed.store(true, Ordering::Relaxed);
        let ext_probe = FakeProbe {
            delay_ms: 0,
            calls: Arc::clone(&calls),
            uptime: Arc::clone(&uptime),
            lid_closed: Arc::clone(&lid_closed),
        };
        let ext_disp = FakeDisplay {
            brightness: Arc::clone(&bright),
        };
        let tick = crate::guard::run_guard_tick_locked(&dir, &ext_probe, &ext_disp).unwrap();
        assert!(tick.changed);
        assert_eq!(*bright.lock().unwrap(), 0.45);
        let closed_col = engine.collect(false);
        assert!(!closed_col.from_cache);
        assert_eq!(closed_col.snapshot.guard_status, "protecting");

        // 5. configure() wakes guard asynchronously without running blocking hardware guard ticks
        *bright.lock().unwrap() = 0.65;
        let e1 = Arc::clone(&engine);
        let t_old = std::thread::spawn(move || e1.collect(true));
        std::thread::sleep(Duration::from_millis(10));
        engine
            .configure(&SettingsPatch {
                mode_override: Some("strict".into()),
                guard_enabled: Some(true),
                ..SettingsPatch::default()
            })
            .unwrap();
        // configure() leaves the current display brightness unchanged
        assert_eq!(*bright.lock().unwrap(), 0.65);

        engine
            .configure(&SettingsPatch {
                guard_enabled: Some(false),
                ..SettingsPatch::default()
            })
            .unwrap();
        let cfg_res = engine.collect(true);
        let old_res = t_old.join().unwrap();
        assert_eq!(old_res.snapshot.policy.profile, "eco");
        assert_eq!(cfg_res.snapshot.policy.profile, "strict");
        assert_eq!(cfg_res.snapshot.guard_status, "paused");

        let cached = engine.collect(false);
        assert!(cached.from_cache);
        assert_eq!(cached.snapshot.policy.profile, "strict");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn collect_swr_returns_cached_snapshot_without_blocking_and_refreshes_in_bg() {
        let dir =
            std::env::temp_dir().join(format!("mac-clamshell-swr-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let calls = Arc::new(AtomicUsize::new(0));
        let uptime = Arc::new(AtomicU64::new(3600));
        let lid_closed = Arc::new(AtomicBool::new(false));
        let bright = Arc::new(Mutex::new(0.70f32));

        let engine = Arc::new(TelemetryEngine::with_ttl(
            dir.clone(),
            "mac-clamshell-mcp".into(),
            FakeProbe {
                delay_ms: 80,
                calls: Arc::clone(&calls),
                uptime: Arc::clone(&uptime),
                lid_closed: Arc::clone(&lid_closed),
            },
            FakeDisplay {
                brightness: Arc::clone(&bright),
            },
            TestFanSensor("active:2140,2210"),
            10,
        ));

        let cold = engine.collect_swr();
        assert!(!cold.from_cache);
        assert!(!cold.stale);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(cold.snapshot.host.uptime_seconds, 3600);

        // Expire short TTL and mutate uptime; collect_swr() must return immediately without waiting 80ms.
        std::thread::sleep(Duration::from_millis(20));
        uptime.store(3720, Ordering::Relaxed);
        let t0 = Instant::now();
        let stale = engine.collect_swr();
        let elapsed_ms = t0.elapsed().as_millis();
        assert!(
            elapsed_ms < 40,
            "SWR boot read must not block on 80ms probe (took {elapsed_ms}ms)"
        );
        assert!(stale.from_cache);
        assert!(stale.stale);
        assert_eq!(stale.server_ms, 0);
        assert_eq!(stale.snapshot.host.uptime_seconds, 3600);

        // Background SWR thread completes and populates fresh cache.
        for _ in 0..30 {
            if calls.load(Ordering::SeqCst) >= 2 {
                break;
            }
            std::thread::sleep(Duration::from_millis(15));
        }
        std::thread::sleep(Duration::from_millis(25));
        let refreshed = engine.collect(false);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(refreshed.snapshot.host.uptime_seconds, 3720);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
