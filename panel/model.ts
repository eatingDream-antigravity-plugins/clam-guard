// Pure locale, i18n, duration, policy, guard, fan ownership, and error helpers.
const SYS = "System (macOS)";
const MAN = "Manual (SMC)";
const UNK = "Unknown";

export type PanelLang = "en" | "zh-CN";
export type BadgeKind = "ok" | "wn" | "er" | "in" | "ac" | "t3";

export interface SettingsState {
  modeOverride?: string;
  maxJobsOverride?: number;
  guardEnabled?: boolean;
  acClosedProfile?: string;
  thermalBrightCapPct?: number;
  pollIntervalSec?: number;
  bgPollIntervalSec?: number;
  lang?: string | null;
}

export interface PolicyState {
  profile?: string;
  autoProfile?: string;
  modeSource?: string;
  maxJobs?: number;
  niceLevel?: number;
  jobsOverridden?: boolean;
}

export interface DisplayState {
  available?: boolean;
  percent?: number;
  savedPercent?: number;
  asleep?: boolean;
  confirmedAsleep?: boolean;
  internalOffline?: boolean;
}

export interface FanEntry {
  id?: number;
  label?: string;
  rpm?: number;
  manual?: boolean;
}

export interface FanState {
  status?: string;
  fans?: FanEntry[];
  smcMode?: string;
  controller?: string;
  externalManagers?: string[];
  detectedMonitors?: string[];
  ownershipMode?: string;
  readOnly?: boolean;
  sampledAtMs?: number;
  stale?: boolean;
  note?: string;
}

export interface HostMemory {
  usedGb?: number;
  totalGb?: number;
  compressedGb?: number;
  usedPct?: number;
}

export interface HostInfo {
  hostname?: string;
  chip?: string;
  macosVersion?: string;
  uptimeSeconds?: number;
  loadAvg?: number[];
  memory?: HostMemory;
}

export interface CpuTopology {
  total?: number;
  performanceCores?: number;
  efficiencyCores?: number;
}

export interface PanelSnapshot {
  timestamp?: string;
  locale?: string;
  lidState?: string;
  clamshellCausesSleep?: string;
  powerSource?: string;
  batteryPct?: number | null;
  thermalState?: string;
  thermalPressure?: string;
  lowPowerMode?: string | number;
  cpuSpeedLimitPct?: number | null;
  degraded?: boolean;
  stale?: boolean;
  unchanged?: boolean;
  bootTs?: number;
  hash?: string;
  serverMs?: number;
  guardStatus?: string;
  settingsError?: string | boolean | null;
  paths?: { settingsPath?: string };
  displayGuard?: {
    thermalCapped?: boolean;
    preThermalBrightness?: number | null;
  };
  brightnessAction?: {
    mode?: string;
    savedPercent?: number;
    percent?: number;
  };
  cpuTopology?: CpuTopology;
  host?: HostInfo;
  settings?: SettingsState;
  policy?: PolicyState;
  profileJobs?: Record<string, number | undefined>;
  envVars?: Record<string, string>;
  display?: DisplayState;
  fan?: FanState;
}

export interface FanDescription {
  status: string;
  rpmText: string;
  showController: boolean;
  controller: string;
  badgeText: string;
  badgeKind: "in" | "wn";
  tooltip: string;
  caption: string;
}

// Single-source EN/ZH table parsed into I18N.en & I18N.zh for 1:1 parity & no-CJK guard checks.
const RAW =
  "k0|Lid|机盖;k1|Power|电源;k2|Heat|温度;k3|Guard|守护;k4|Brightness|亮度;k5|Lid guard|合盖保护;k6|Lock|锁屏;k7|Mode|模式;k8|Parallel jobs|并行任务;ar|Auto|恢复自动;k9|Fans|风扇;ka|Controlled by|控制方式;kb|Details|详情;kc|CPU & memory|CPU 与内存;kd|Load & power|负载与电源;" +
  "m0|Auto|自动;m1|Normal|正常;m2|Cool|控温;m3|Eco|节能;m4|Strict|严格;" +
  "a0|Auto refresh|自动刷新;a1|Language|语言;a2|Settings|设置;a4|Refresh|刷新;a5|Dismiss|关闭;a6|Fewer jobs|减少任务;a7|More jobs|增加任务;" +
  "r0|Retry|重试;r1|Loading…|正在加载…;r2|Unknown|未知;r3|Screen off|已熄屏;r4|Closed|已合盖;r5|Open|已开盖;r6|Battery|电池;r7|AC|插电;" +
  "t1|Warm|偏热;t2|Hot · slowing|过热降频;t3|Critical|严重过热;" +
  "g0|Paused|已暂停;g1|Protecting|保护中;g2|Dimmed for heat|高温降亮;g3|On|运行中;g4|Idle|空闲;" +
  "s0|Saving…|正在保存…;s1|Saved|已保存;s2|Reconnected|已重新连接;s3|Will restore to {n}%|唤醒后恢复 {n}%;s4|Brightness {n}%|亮度 {n}%;s5|Locking…|已发送锁屏;s6|Locked|已锁屏;" +
  "e0|Couldn't refresh|刷新失败;e1|Couldn't change brightness|亮度调节失败;e2|Couldn't lock|锁屏失败;e3|Couldn't save|保存失败;e4|This Mac has no built-in screen.|这台 Mac 没有内建屏幕。;e5|Brightness must be between 0 and 100.|亮度需在 0 到 100 之间。;e6|Invalid request.|请求参数有误。;e7|Unknown action.|不支持的操作。;" +
  "b0|Disconnected|连接断开;b1|retrying in {dur}|{dur}后重试;b2|Auto refresh off|自动刷新已关;b3|Background refresh|后台刷新中;b4|Paused|暂停;b5|Updated {t}|更新于 {t};b6|Auto · {dur}|自动 · {dur};b7|Manual|手动;" +
  "p0|No limits|不限制;p1|Lower priority|降低优先级;p2|Efficiency cores only|仅用能效核;p3|Background priority|后台优先级;p4|Priority +{n}|优先级 +{n};" +
  "d0|Restores to|恢复亮度;d1|No built-in screen|没有内建屏幕;d2|Lid closed · screen off|已合盖 · 屏幕已关;d3|Lid closed · screen still on|已合盖 · 屏幕仍亮着;d4|wakes at {n}%|唤醒后 {n}%;d5|Dimmed for heat|高温降亮中;" +
  "d6|Up {dur}|已开机 {dur};d7|{n} cores|{n} 核;d8|{n} jobs|{n} 个任务;d9|1 job|1 个任务;da|Auto · {n}|自动 · {n};db|Mem {n}%|内存 {n}%;dc|{n} GB compressed|已压缩 {n} GB;dd|Load|负载;de|CPU capped at {n}%|CPU 限速 {n}%;df|Stays awake when closed|合盖不睡眠;dg|Sleeps when closed|合盖睡眠;dh|Low Power Mode:|低电量模式：;di|On|开;dj|Off|关;" +
  "x0|Some readings aren't available on this Mac.|这台 Mac 有部分数据读不到。;x2|Hide|收起;" +
  "c2|Follow system|跟随系统;c3|When plugged in & closed|插电合盖时;c4|Dim when hot|高温降亮;c5|Caps brightness while the Mac is hot.|过热时把亮度压到这个上限;c6|Keep screen off when closed|合盖时保持熄屏;c7|Refresh rate|刷新频率;c8|Background refresh|后台刷新;c9|Settings file:|配置文件：;ca|Copy|复制;cb|Copied|已复制;cc|settings.json has an error. Using your last good settings.|配置文件有误，暂时沿用上次的有效设置。;" +
  "u0|Lost connection to Antigravity.|与 Antigravity 的连接已断开。;u1|Antigravity didn't respond. Try again.|Antigravity 没有响应，请重试。;u2|Couldn't start the panel. Reopen it.|面板没能启动，请重新打开。;u3|This panel can't run actions here.|当前环境不支持面板操作。;u4|Something went wrong. Try again.|出了点问题，请重试。;" +
  "w0|Guard paused|守护已暂停;w1|Keeping screen off · wakes at {n}%|保持熄屏 · 唤醒后 {n}%;w2|Dimmed for heat · back to {n}% when cool|高温降亮 · 降温后恢复 {n}%;w3|Guard on|守护中;w4|Guard idle|守护空闲;" +
  "f0|macOS (auto)|macOS 自动;f3|guard paused.|守护已暂停。;f4|guard on.|守护中。;f5|Passive cooling|无风扇被动散热;f6|No fans (passive cooling)|无风扇（被动散热）;f7|Read-only|只读;f8|External|外部控制;f9|Can't read fan speed|读不到转速;fa|Can't read fans — {tail}|读不到风扇；{tail};fb|Read-only · fans run by macOS|只读 · 风扇由 macOS 控制;fc|Also running:|检测到：;fd|Clam Guard only reads fans. It never changes their speed.|Clam Guard 只读取风扇状态，从不调速。;fe|Read-only: {ctrl}|只读：{ctrl};ff|Read-only|仅查看";

export const I18N: { en: Record<string, string>; zh: Record<string, string> } = { en: {}, zh: {} };
for (const row of RAW.split(";")) {
  const [k, e, z] = row.split("|");
  I18N.en[k] = e;
  I18N.zh[k] = z;
}

export function t(l: string, k: string, v?: Record<string, string | number>): string {
  let s = (l === "zh-CN" ? I18N.zh : I18N.en)[k] ?? I18N.en[k] ?? k;
  if (v) for (const x in v) s = s.replace(`{${x}}`, String(v[x]));
  return s;
}

export function fmtDur(sec: unknown, l = "en", cmp?: boolean | number): string {
  if (typeof sec !== "number" || !Number.isFinite(sec) || sec < 0) return "-";
  const F = Math.floor;
  const n = F(sec);
  const d = F(n / 86400);
  const h = F((n % 86400) / 3600);
  const m = F((n % 3600) / 60);
  const s = n % 60;
  const p = cmp ? "" : " ";
  const z = l === "zh-CN";
  return d
    ? z
      ? `${d}${p}天` + (h ? `${p}${h}${p}小时` : "")
      : `${d}d` + (h ? ` ${h}h` : "")
    : h
      ? z
        ? `${h}${p}小时` + (m ? `${p}${m}${p}分` : "")
        : `${h}h` + (m ? ` ${m}m` : "")
      : m
        ? z
          ? `${m}${p}分钟`
          : `${m}m`
        : z
          ? `${s}${p}秒`
          : `${s}s`;
}

export const mapBridgeError = (r: unknown, l = "en"): string => {
  const msg = r && typeof r === "object" && "message" in r ? (r as { message?: unknown }).message : r;
  const m = ("" + (msg ?? "")).trim();
  return t(
    l,
    /^(Closed|Not connected)$/i.test(m)
      ? "u0"
      : /^Timeout:/i.test(m)
        ? "u1"
        : /^(Bad|Unsupported|Parent|Init:)/i.test(m)
          ? "u2"
          : /^No (serverTools|tool)/i.test(m)
            ? "u3"
            : "u4"
  );
};

export const normalizeLang = (r: unknown): PanelLang | null => {
  const s = ("" + (r ?? "")).trim().toLowerCase();
  return !s || s === "auto" ? null : /^zh($|[-_])/.test(s) ? "zh-CN" : "en";
};

export interface ResolvePanelLangOptions {
  saved?: unknown;
  settingsLang?: unknown;
  hostLocale?: unknown;
  navLang?: unknown;
  bootLocale?: unknown;
}

export function resolvePanelLang({
  saved,
  settingsLang,
  hostLocale,
  navLang,
  bootLocale,
}: ResolvePanelLangOptions = {}): PanelLang {
  for (const x of [saved, settingsLang, hostLocale, bootLocale, navLang]) {
    const n = normalizeLang(x);
    if (n) return n;
  }
  return "en";
}

export function computeOptimisticState<T extends PanelSnapshot>(b: T, p: Partial<SettingsState>): T;
export function computeOptimisticState(b: null | undefined, p: Partial<SettingsState>): null | undefined;
export function computeOptimisticState(
  b: PanelSnapshot | null | undefined,
  p: Partial<SettingsState>
): PanelSnapshot | null | undefined {
  if (!b) return b;
  const s: SettingsState = { ...b.settings, ...p };
  const tot = Math.max(1, +(b.cpuTopology?.total ?? 0) || 8);
  const bp = b.policy || {};
  let ap = bp.autoProfile || "normal";
  if (
    p?.acClosedProfile &&
    !["warn", "serious", "critical"].includes(b.thermalState ?? "") &&
    b.lidState === "closed" &&
    b.powerSource !== "battery"
  ) {
    ap = s.acClosedProfile === "eco" ? "eco" : "utility";
  }
  const ov = s.modeOverride || "auto";
  const man = ov !== "auto";
  const prof = man ? ov : ap;
  const pj = b.profileJobs;
  const tj = pj ? (!man && prof === "eco" && pj.autoEco != null ? pj.autoEco : pj[prof]) : null;
  const jo = (s.maxJobsOverride ?? 0) > 0;
  const maxJobs = jo
    ? Math.min(s.maxJobsOverride ?? tot, tot)
    : tj ?? (prof === "strict" ? 1 : prof === "normal" ? tot : bp.maxJobs || tot);
  let gs = b.guardStatus || "armed";
  if (s.guardEnabled === false) gs = "paused";
  else if (gs === "paused") {
    gs = b.lidState === "closed" ? "protecting" : b.displayGuard?.thermalCapped ? "thermal_cap" : "armed";
  }
  const niceMap: Record<string, number | undefined> = { strict: 19, eco: 15, utility: 10, normal: 0 };
  return {
    ...b,
    settings: s,
    guardStatus: gs,
    policy: {
      ...bp,
      profile: prof,
      autoProfile: ap,
      modeSource: man ? "manual" : "auto",
      maxJobs,
      niceLevel: niceMap[prof] ?? bp.niceLevel ?? 0,
      jobsOverridden: jo,
    },
    envVars:
      prof === "normal" && !jo
        ? {}
        : Object.keys(b.envVars || {}).length
          ? b.envVars
          : { MAKEFLAGS: `-j${maxJobs}` },
  };
}

export const describeGuardStatus = (d: PanelSnapshot | null | undefined, rp: number, l = "en"): string => {
  const st = d?.settings?.guardEnabled === false ? "paused" : d?.guardStatus || (d?.displayGuard ? "armed" : "idle");
  const keyMap: Record<string, string> = { paused: "w0", protecting: "w1", thermal_cap: "w2", armed: "w3" };
  return t(l, keyMap[st] || "w4", {
    n:
      st === "thermal_cap" && d?.displayGuard?.preThermalBrightness != null
        ? Math.round(d.displayGuard.preThermalBrightness * 100)
        : rp,
  });
};

const rpm = (n: unknown): string => Math.max(0, Math.round(+(n ?? 0) || 0)).toLocaleString("en-US");

export function describeFanState(f: FanState | null | undefined, l = "en", gp?: boolean): FanDescription {
  const z = l === "zh-CN";
  const sep = z ? "、" : ", ";
  const st = f?.status || "unavailable";
  const fs = f?.fans || [];
  const ex = f?.externalManagers || [];
  const mon = f?.detectedMonitors || [];
  const y = f?.ownershipMode === "yield";
  const sm = f?.smcMode || (st === "unavailable" ? "unknown" : st === "fanless" ? "none" : "auto");
  const rc = f?.controller || (sm === "unknown" ? UNK : SYS);
  const base =
    rc === SYS
      ? t(l, "f0")
      : rc === MAN
        ? t(l, "b7")
        : rc.startsWith(`${MAN} (`) && rc.endsWith(")")
          ? `${t(l, "b7")} · ${rc.slice(MAN.length + 2, -1).split(/,\s*/).join(sep)}`
          : rc === UNK
            ? t(l, "r2")
            : rc;
  const ctrl = ex.length && (rc === SYS || rc === UNK) ? `${base} · ${ex.join(sep)}` : base;
  const gT = t(l, gp ? "f3" : "f4");
  const fd = t(l, "fd");
  if (st === "fanless") {
    return {
      status: st,
      rpmText: t(l, "f6"),
      showController: false,
      controller: ctrl,
      badgeText: t(l, "ff"),
      badgeKind: "in",
      tooltip: fd,
      caption: `${t(l, "f5")}${z ? "；" : " — "}${gT}`,
    };
  }
  const rpmText =
    st === "ok" && fs.length === 2
      ? z
        ? `左 ${rpm(fs[0].rpm)} · 右 ${rpm(fs[1].rpm)} rpm`
        : `L ${rpm(fs[0].rpm)} · R ${rpm(fs[1].rpm)} rpm`
      : st === "ok" && fs.length
        ? `${fs.map((x) => rpm(x.rpm)).join(" · ")} rpm`
        : t(l, "f9");
  const ro = t(l, "f7");
  const smL = t(l, sm === "manual" ? "b7" : sm === "auto" ? "f0" : "r2");
  const caption =
    st === "unavailable"
      ? t(l, "fa", { tail: gT })
      : ex.length
        ? `${ro} · ${smL} · ${ex.join(sep)}`
        : sm === "manual" || sm === "unknown"
          ? `${ro} · ${smL}`
          : mon.length
            ? `${ro} · ${t(l, "fc")} ${mon.join(sep)}`
            : t(l, "fb");
  return {
    status: st,
    rpmText,
    showController: true,
    controller: ctrl,
    badgeText: t(l, y ? "f8" : "ff"),
    badgeKind: y ? "wn" : "in",
    tooltip: y ? t(l, "fe", { ctrl }) : fd,
    caption,
  };
}
