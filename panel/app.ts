import { App } from "./kit/bridge.ts";
import type { HostContext, ToolCallResult } from "./kit/bridge.ts";
import { attachRevealRefresh, createAdaptivePoller } from "./polling.ts";
import type { PollerMetrics } from "./polling.ts";
import { clampPercent, createBrightnessController } from "./brightness.ts";
import {
  computeOptimisticState,
  describeFanState,
  describeGuardStatus,
  fmtDur,
  I18N,
  mapBridgeError,
  resolvePanelLang,
  t,
} from "./model.ts";
import type { BadgeKind, PanelLang, PanelSnapshot, SettingsState } from "./model.ts";

interface ErrSpec {
  key?: string;
  br?: string;
  raw?: string;
  vars?: Record<string, string | number>;
}

interface FeedbackState {
  k: "ok" | "er";
  spec: ErrSpec;
  retry: (() => void) | null;
}

interface EmptyState {
  sp?: ErrSpec;
  k?: string;
  r?: 1 | boolean;
}

interface RpcError extends Error {
  isBridge?: boolean;
  errorKind?: string;
  errorDetail?: string;
}

type TimerId = ReturnType<typeof setTimeout> | null;
type CfgEntry = readonly [
  labelKey: string,
  hintKey: string | 0,
  attr: string,
  vals?: readonly (string | number)[],
  settingKey?: keyof SettingsState,
  isNum?: 1,
];

const doc = document;
const docEl = doc.documentElement;
const $ = (id: string): HTMLElement | null => doc.getElementById(id);
const root = $("app");
const st = globalThis.setTimeout;
const ct = (id: TimerId): void => {
  if (id !== null) clearTimeout(id);
};
const M = Math;

const boot: PanelSnapshot | null =
  typeof window < "u"
    ? (window as Window & { __MAC_CLAMSHELL_BOOT__?: PanelSnapshot | null }).__MAC_CLAMSHELL_BOOT__ || null
    : null;

const PR = [0, 20, 50, 80, 100] as const;
const MD = ["auto", "normal", "utility", "eco", "strict"] as const;
const LKEY = "mac-clamshell-lang";
const SKEY = "mac-clamshell-snap";
const AC = "aria-checked";
const AD = "aria-disabled";
const AP = "aria-pressed";
const AR = "ArrowRight";
const AL = "ArrowLeft";
const PU = "pointerup";
const PC = "pointercancel";

const CFG: readonly CfgEntry[] = [
  ["a1", 0, "cl", ["auto", "en", "zh-CN"]],
  ["c3", 0, "ac", ["utility", "eco"], "acClosedProfile"],
  ["c4", "c5", "tc", [0, 30, 50, 70], "thermalBrightCapPct", 1],
  ["c6", 0, "cg"],
  ["c7", 0, "pl", [0, 3, 5, 10, 30], "pollIntervalSec", 1],
  ["c8", 0, "bg", [0, 10, 30, 60, -1], "bgPollIntervalSec", 1],
];

const MK: Record<string, string> = { auto: "m0", normal: "m1", utility: "m2", eco: "m3", strict: "m4" };
const KK: Record<string, string> = {
  no_builtin_display: "e4",
  invalid_brightness: "e5",
  config_failed: "e3",
  brightness_failed: "e1",
  lock_failed: "e2",
  invalid_args: "e6",
  unknown_tool: "e7",
};

const storeL = (v?: string | null): string | null => {
  try {
    if (typeof localStorage >= "u") return null;
    if (v === undefined) return localStorage.getItem(LKEY);
    if (v === null) localStorage.removeItem(LKEY);
    else localStorage.setItem(LKEY, v);
    return v;
  } catch {
    return null;
  }
};

interface CachedSnap {
  v: 1;
  savedAt: number;
  data: PanelSnapshot;
}

const loadSnap = (): CachedSnap | null => {
  try {
    if (typeof localStorage >= "u") return null;
    const raw = localStorage.getItem(SKEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<CachedSnap> | null;
    return p && p.v === 1 && typeof p.savedAt === "number" && p.data && typeof p.data === "object"
      ? (p as CachedSnap)
      : null;
  } catch {
    return null;
  }
};

const saveSnap = (s: PanelSnapshot | null): void => {
  if (!s || s.unchanged) return;
  try {
    if (typeof localStorage >= "u") return;
    const { brightnessAction: _ba, paths, ...rest } = s as PanelSnapshot & {
      paths?: { settingsPath?: string; binaryPath?: string };
    };
    const data = paths?.settingsPath ? { ...rest, paths: { settingsPath: paths.settingsPath } } : rest;
    localStorage.setItem(SKEY, JSON.stringify({ v: 1, savedAt: Date.now(), data }));
  } catch {}
};

const cachedSnap = loadSnap();
const useCached = !!cachedSnap && (!boot || cachedSnap.savedAt > (boot.bootTs ?? 0));
const initSnap: PanelSnapshot | null = useCached ? cachedSnap.data : boot;

let hostLoc: string | null = null;
const resL = (sl: unknown, bl: unknown): PanelLang =>
  resolvePanelLang({
    saved: storeL(),
    settingsLang: sl,
    hostLocale: hostLoc,
    navLang: typeof navigator < "u" ? navigator.language : null,
    bootLocale: bl,
  });

let lang: PanelLang = resL(initSnap?.settings?.lang, initSnap?.locale);
let I: Record<string, string> = lang === "zh-CN" ? I18N.zh : I18N.en;
docEl.lang = lang;

const tr = (k: string, v?: Record<string, string | number>): string => t(lang, k, v);
const mN = (id: string): string => I[MK[id] || "m0"];
const pL = (s: number): string => (s ? (s < 0 ? I.b4 : fmtDur(s, lang)) : I.m0);

let cur: PanelSnapshot | null = initSnap;
let conf: PanelSnapshot | null = initSnap;
let hash = initSnap?.hash || "";
let loading = !initSnap;
let first = !initSnap || useCached || !!boot?.stale;
let syncing = false;
let bSync = false;
let locking = false;
let optB: number | null = null;
let fb: FeedbackState | null = null;
let fbT: TimerId = null;
let netM: PollerMetrics | null = null;
let envK = "";
let pend: Partial<SettingsState> | null = null;
let inF = false;
let gen = 0;
let pollSeq = 0;
let drag = false;
let defr = false;
let busyT: TimerId = null;
let spin = false;
let fails = 0;
let off = false;
let bnrX = false;
let bnrE: ErrSpec | null = null;
let canT = false;
let autoW = true;
let cfgO = false;
let cfgT: TimerId = null;
let cpT: TimerId = null;
let cpOk = false;
let emp: EmptyState | null = null;
let rawS = "";
let lastSL: string | null = initSnap?.settings?.lang ?? null;

const num = (v: unknown, d = 0): number => (v != null && Number.isFinite(+v) ? +v : d);
const qa = (s: string): NodeListOf<HTMLElement> | never[] => root?.querySelectorAll?.<HTMLElement>(s) || [];
const q1 = (s: string): HTMLElement | null => root?.querySelector?.<HTMLElement>(s) || null;
const ga = (e: Element | null | undefined, k: string): string | null => e?.getAttribute?.(k) ?? null;
const sa = (e: Element | null | undefined, k: string, v: string | number | boolean): void => {
  const s = "" + v;
  if (e && e.getAttribute(k) !== s) e.setAttribute(k, s);
};
const da = (e: Element | null | undefined, k: string): string | null => ga(e, "data-" + k);
const sda = (e: Element | null | undefined, k: string, v: string | number | boolean): void => sa(e, "data-" + k, v);

const app = App(
  { name: "Clam Guard", version: ga(doc.querySelector?.('meta[name="app-version"]'), "content") || "1.4.3" },
  {}
);

const tx = (e: string | Element | null, v: unknown): void => {
  const el = typeof e === "string" ? $(e) : e;
  const s = "" + (v ?? "");
  if (el && el.textContent !== s) el.textContent = s;
};
const vis = (e: string | HTMLElement | null, on: unknown): void => {
  const el = typeof e === "string" ? $(e) : e;
  if (el && el.hidden !== !on) el.hidden = !on;
};
const dis = (id: string, v: boolean): void => {
  const e = $(id) as HTMLButtonElement | null;
  if (e) e.disabled = v;
};
const on = (o: EventTarget | null | undefined, ev: string, fn: (e: never) => void): void => {
  o?.addEventListener(ev, fn as EventListener);
};
const NOOP = (): void => {};
const gOff = (d: PanelSnapshot | null | undefined): boolean => d?.settings?.guardEnabled === false;
const hasD = (d: PanelSnapshot | null | undefined): boolean => !!(d?.display?.available || d?.lidState === "closed");
const cS = (e: Event, s: string): HTMLElement | null => (e.target as Element | null)?.closest?.<HTMLElement>(s) ?? null;

const fmtT = (iso?: string): string => {
  if (!iso) return "-";
  const d = new Date(iso);
  return d.getTime() === d.getTime() ? d.toTimeString().slice(0, 8) : iso;
};
const lidS = (l?: string): string => I[(l === "closed" || l === "open" ? { closed: "r4", open: "r5" }[l] : "r2")];
const pwrS = (p?: string, pct?: number | null): string => {
  const k = p === "battery" ? "r6" : p === "ac" ? "r7" : "";
  return k ? I[k] + (pct != null ? ` ${pct}%` : "") : I.r2;
};

const TH: Record<string, readonly [string, BadgeKind]> = {
  critical: ["t3", "er"],
  serious: ["t2", "er"],
  fair: ["t1", "wn"],
  unknown: ["r2", "t3"],
};
const thI = (d: PanelSnapshot | null | undefined): readonly [string, BadgeKind] => {
  const r: readonly [string, BadgeKind] =
    (d?.thermalPressure && TH[d.thermalPressure]) ||
    (d?.thermalState === "warn" ? TH.serious : d?.thermalState === "unknown" ? TH.unknown : ["m1", "ok"]);
  return [I[r[0]], r[1]];
};

const GR: Record<string, readonly [string, BadgeKind, number?]> = {
  paused: ["g0", "wn", 1],
  protecting: ["g1", "ok"],
  thermal_cap: ["g2", "wn"],
  armed: ["g3", "ok"],
};
const grH = (d: PanelSnapshot | null | undefined): readonly [string, BadgeKind, boolean] => {
  const key = gOff(d) ? "paused" : d?.guardStatus || "idle";
  const r: readonly [string, BadgeKind, number?] = GR[key] || ["g4", "t3"];
  return [I[r[0]], r[1], !!r[2]];
};

const effB = (d: PanelSnapshot | null | undefined): number | null =>
  optB !== null
    ? optB
    : !d?.display
      ? null
      : d.lidState === "closed" || d.display.asleep
        ? d.display.savedPercent ?? d.display.percent ?? 20
        : d.display.percent ?? d.display.savedPercent ?? null;

function mount(): void {
  if (!doc.createElement) return;
  const mk = <K extends keyof HTMLElementTagNameMap>(t: K, c?: string | 0, id?: string): HTMLElementTagNameMap[K] =>
    Object.assign(doc.createElement(t), c ? { className: c } : {}, id ? { id } : {});
  const bt = (r: string, a: string, v: string | number, x?: string): HTMLButtonElement => {
    const b = mk("button");
    b.type = "button";
    sa(b, "role", r);
    sda(b, a, v);
    if (x) b.textContent = x;
    return b;
  };
  const rails: ReadonlyArray<readonly [string, readonly (string | number)[], string, ((n: string | number) => string)?]> = [
    ["prs-grp", PR, "br", (n) => `${n}%`],
    ["mode-rail", MD, "m"],
  ];
  for (const [id, arr, a, fn] of rails) {
    const h = $(id);
    if (h?.appendChild) for (const v of arr) h.appendChild(bt("radio", a, v, fn?.(v)));
  }
  const cr = $("cr");
  if (cr?.appendChild) {
    for (const [lk, hk, a, vals] of CFG) {
      const row = mk("div", "r");
      const lbl = mk("span", 0, "cl-" + lk);
      if (hk) {
        const g = mk("div", "c");
        g.appendChild(lbl);
        g.appendChild(mk("span", "m", "cl-" + hk));
        row.appendChild(g);
      } else {
        row.appendChild(lbl);
      }
      if (vals) {
        const g = mk("div", "ss", a === "ac" ? "ac-grp" : a);
        sa(g, "role", "radiogroup");
        for (const v of vals) g.appendChild(bt("radio", a, v));
        row.appendChild(g);
      } else {
        const sw = bt("switch", "a", "guard");
        sw.id = a;
        sw.className = "ns";
        sa(sw, "aria-labelledby", lbl.id);
        sw.appendChild(mk("span", "sk"));
        row.appendChild(sw);
      }
      cr.appendChild(row);
    }
  }
}

const exErr = (e: unknown, fk: string): ErrSpec => {
  const errObj = e && typeof e === "object" ? (e as Partial<RpcError>) : null;
  const k = errObj?.errorKind;
  const raw = errObj?.errorDetail || errObj?.message || "" + (e || "");
  return k && KK[k] ? { key: KK[k], raw } : errObj?.isBridge ? { br: raw, raw } : { key: fk, raw };
};
const errT = (sp?: ErrSpec | null): string => (sp?.br ? mapBridgeError(sp.br, lang) : tr(sp?.key || "u4", sp?.vars));
const pRaw = (): void => {
  const s =
    rawS === "fb"
      ? fb?.k === "er"
        ? fb.spec?.raw
        : ""
      : rawS === "bnr"
        ? bnrE?.raw
        : rawS === "emp"
          ? emp?.sp?.raw
          : "";
  if (!s) rawS = "";
  vis("raw", s);
  if (s) tx("raw", s);
};
const det = (id: string, has: unknown, k: string): void => {
  vis(id, has);
  if (has) tx(id, rawS === k ? I.x2 : I.kb);
};
const setFb = (k: "ok" | "er", spec: ErrSpec, retry: (() => void) | null = null): void => {
  fb = { k, spec, retry };
  if (rawS === "fb") rawS = "";
  ct(fbT);
  if (k === "ok") {
    fbT = st(() => {
      fb = null;
      patchFb();
    }, 2400);
  }
  patchFb();
};
const setOk = (key: string, vars?: Record<string, string | number>): void => setFb("ok", { key, vars });
const setErr = (e: unknown, fk: string, r?: () => void): void => setFb("er", exErr(e, fk), r ?? null);

function patchFb(): void {
  const p = $("fb-p");
  if (!p) return;
  if (syncing || bSync) {
    vis(p, 1);
    sda(p, "k", "ac");
    vis("fb-d", 1);
    tx("fb-t", I.s0);
    vis("fb-det", 0);
    vis("fb-r", 0);
  } else if (fb) {
    const er = fb.k === "er";
    vis(p, 1);
    sda(p, "k", fb.k);
    vis("fb-d", 0);
    tx("fb-t", er ? errT(fb.spec) : `✓ ${tr(fb.spec.key || "s1", fb.spec.vars)}`);
    det("fb-det", er && fb.spec?.raw, "fb");
    vis("fb-r", er && fb.retry);
    if (er && fb.retry) tx("fb-r", I.r0);
  } else {
    vis(p, 0);
  }
  pRaw();
}

function patchDot(d: PanelSnapshot | null = cur): void {
  const p = d?.policy?.profile || "normal";
  const thK = d ? thI(d)[1] : "ok";
  const grP = d ? grH(d)[2] : false;
  const hd = $("hd");
  sda(
    hd,
    "st",
    off || bnrE || p === "strict" || thK === "er" || d?.degraded
      ? "err"
      : grP || p === "utility" || p === "eco" || thK === "wn"
        ? "wait"
        : "run"
  );
  if (hd) hd.title = d?.degraded ? I.x0 : "";
}

function patchBnr(): void {
  const b = $("bnr");
  if (!b) return;
  if ((bnrE || off) && !bnrX) {
    const net = netM || poller.getMetrics();
    const s = M.max(1, M.round((net.currentIntervalMs || 5e3) / 1e3));
    vis(b, 1);
    sda(b, "k", bnrE ? "er" : "wn");
    tx("bnr-t", bnrE ? errT(bnrE) : `${I.b0} · ${canT && net.enabled ? tr("b1", { dur: fmtDur(s, lang) }) : I.b2}`);
    det("bnr-det", bnrE?.raw, "bnr");
    vis("bnr-act", 1);
    tx("bnr-act", I.r0);
  } else {
    vis(b, 0);
    if (rawS === "bnr") rawS = "";
  }
  pRaw();
}

const onOk = (): void => {
  const w = off || bnrE;
  fails = 0;
  off = bnrX = first = false;
  bnrE = null;
  if (rawS === "bnr") rawS = "";
  patchDot();
  patchBnr();
  if (w) setOk("s2");
};

const onFail = (r: string): void => {
  first = false;
  if (r === "poll" && ++fails >= 3) {
    off = true;
    bnrX = false;
  }
  patchDot();
  patchBnr();
};

function syncSnap(p: PanelSnapshot): void {
  const s = p?.settings;
  if (!s) return;
  poller.setIntervals({ fgSec: s.pollIntervalSec || 0, bgSec: s.bgPollIntervalSec || 0 });
  const nl = s.lang ?? null;
  if (nl !== lastSL) {
    lastSL = nl;
    storeL(nl);
    const r = resL(nl, p.locale);
    if (r !== lang) {
      lang = r;
      patchI18n();
    }
  }
}

function applyData(p: PanelSnapshot | null | undefined): void {
  if (!p || typeof p !== "object") return;
  if (p.hash) hash = p.hash;
  if (p.unchanged) {
    const t0 = p.timestamp;
    if (cur && t0) {
      cur = { ...cur, timestamp: t0 };
      if (conf) {
        conf = { ...conf, timestamp: t0 };
        saveSnap(conf);
      }
    }
    return;
  }
  conf = p;
  cur = syncing && cur?.settings ? computeOptimisticState(p, cur.settings) : p;
  syncSnap(p);
  saveSnap(p);
}

function renderEmp(): void {
  if (!emp) return;
  vis("shell", 0);
  vis("emp", 1);
  tx("emp-msg", emp.sp ? errT(emp.sp) : I[emp.k || "r1"]);
  vis("emp-btn", emp.r);
  if (emp.r) tx("emp-btn", I.r0);
  det("emp-det", emp.sp?.raw, "emp");
  pRaw();
}
const showEmpty = (s: EmptyState): void => {
  emp = s;
  if (rawS === "emp") rawS = "";
  renderEmp();
};

function patchI18n(): void {
  docEl.lang = lang;
  I = lang === "zh-CN" ? I18N.zh : I18N.en;
  for (const id of "k0,k1,k2,k3,k4,k5,k6,k7,k8,ar,k9,ka,kb,kc,kd".split(",")) tx(id, I[id]);
  tx("ch", I.a2);
  tx("cf", I.c9);
  tx("cet", I.cc);
  tx("cb", cpOk ? `✓ ${I.cb}` : I.ca);
  for (const [lk, hk] of CFG) {
    tx("cl-" + lk, I[lk]);
    if (hk) tx("cl-" + hk, I[hk]);
  }
  for (const p of "#auto-chip:a0,#lang-grp:a1,#cfg-btn:a2,#lock-btn:k6,#refresh-btn:a4,#bnr-x:a5,#cx:a5,#jd:a6,#ji:a7".split(",")) {
    const [s, k] = p.split(":");
    sa(q1(s), "aria-label", I[k]);
  }
  for (const b of qa("[data-m],[data-ac]")) tx(b, mN(da(b, "m") || da(b, "ac") || ""));
  for (const b of qa("[data-tc]")) {
    const v = +(da(b, "tc") ?? 0);
    tx(b, v ? `${v}%` : I.dj);
  }
  for (const b of qa("[data-pl],[data-bg]")) tx(b, pL(+(da(b, "pl") ?? da(b, "bg") ?? 0)));
  for (const b of qa("[data-cl]")) {
    const v = da(b, "cl");
    tx(b, v === "auto" ? I.c2 : v === "en" ? "English" : "简体中文");
  }
  for (const b of qa("[data-lg]")) sa(b, AP, da(b, "lg") === lang);
}

function patchChrome(): void {
  const net = netM || poller.getMetrics();
  const ts = cur?.timestamp;
  const paused = !!(cur && (gOff(cur) || cur.guardStatus === "paused"));
  const ch = $("auto-chip") as HTMLButtonElement | null;
  const en = canT && net.enabled;
  if (ts) tx("ht", fmtT(ts));
  tx("ft", net.pausedHidden ? I.b4 : net.inBackground ? I.b3 : "");
  if (ch) {
    const s = M.max(1, M.round((net.currentIntervalMs || 3e3) / 1e3));
    ch.disabled = !canT;
    sda(ch, "on", en);
    sda(ch, "ps", paused);
    sa(ch, AP, en);
    ch.title = ts ? tr("b5", { t: fmtT(ts) }) : "";
    tx($("auto-lbl") || ch.lastElementChild, en ? tr("b6", { dur: fmtDur(s, lang, 1) }) : I.b7);
  }
  dis("lock-btn", locking || !canT);
  dis("refresh-btn", app.isConnected() && !canT);
  sda($("refresh-btn"), "busy", spin);
  sa($("cfg-btn"), "aria-expanded", cfgO);
  vis("cfg-drawer", cfgO);
  vis("swp", first && cur);
  patchDot();
  patchFb();
  patchBnr();
}

function patchBright(pct: number, ok = true, sv = ok): void {
  tx("bv", sv ? `${pct}%` : "-");
  const trk = $("bright-track");
  if (trk) {
    trk.style.setProperty("--pct", `${pct}%`);
    sa(trk, "aria-valuenow", pct);
    sa(trk, AD, !ok);
    trk.tabIndex = ok ? 0 : -1;
  }
  for (const b of qa("[data-bs],[data-br]")) {
    (b as HTMLButtonElement).disabled = !ok;
    const v = da(b, "br");
    if (v !== null) sa(b, AC, sv && +v === pct);
  }
}

function patchEnv(d: PanelSnapshot, prof: string, het: boolean, nice: number): void {
  const el = $("de");
  if (!el) return;
  const es = Object.entries(d.envVars || {});
  const qos = prof === "normal" ? "" : I[prof === "utility" ? "p1" : het ? "p2" : "p3"];
  const k = `${lang}|${prof}|${qos}|${nice}|${es.map((x) => x.join("=")).join(";")}`;
  if (k === envK) return;
  envK = k;
  if (!el.replaceChildren || !doc.createElement) {
    tx(el, I.p0);
    return;
  }
  const mk = (p: string, v: string): HTMLSpanElement => {
    const s = doc.createElement("span");
    s.className = "et";
    if (p) s.appendChild(doc.createTextNode(p));
    const b = doc.createElement("strong");
    b.textContent = "" + v;
    s.appendChild(b);
    return s;
  };
  if (!es.length) {
    const s = doc.createElement("span");
    s.className = "m2";
    s.textContent = I.p0;
    el.replaceChildren(s);
    return;
  }
  el.replaceChildren(
    ...(qos ? [mk("", qos)] : []),
    ...(nice > 0 ? [mk("", tr("p4", { n: nice }))] : []),
    ...es.map(([x, v]) => mk(`${x}=`, v))
  );
}

const setBg = (id: string, text: string, k: BadgeKind = "in", tip = ""): void => {
  const e = $(id);
  if (!e) return;
  vis(e, text);
  if (text) {
    sda(e, "k", k);
    tx(e, text);
    e.title = tip;
  }
};

function patchAll(d: PanelSnapshot | null): void {
  if (!d) return;
  if (drag) {
    defr = true;
    return;
  }
  defr = false;
  emp = null;
  if (rawS === "emp") rawS = "";
  vis("shell", 1);
  vis("emp", 0);
  const {
    policy: p = {},
    settings: s = {},
    display: disp = {},
    host: h = {},
    cpuTopology: ct0 = {},
    lidState: lid,
    powerSource: pwr,
    batteryPct: bp0,
  } = d;
  const rm = h.memory || {};
  const ov = s.modeOverride || "auto";
  const prof = p.profile || "normal";
  const pL0 = mN(prof);
  const cl = lid === "closed";
  const sp = d.paths?.settingsPath || "";
  const dispOk = hasD(d);
  const bV = effB(d) ?? 20;
  const rest = disp.savedPercent ?? bV;
  const [thL, thK] = thI(d);
  const [grL, grK, grP] = grH(d);

  patchDot(d);
  const bp = clampPercent(bp0);
  const bk: BadgeKind =
    pwr === "ac" ? "ok" : pwr !== "battery" || bp0 == null ? "t3" : bp <= 20 ? "er" : bp <= 40 ? "wn" : "ok";
  const heroRows: ReadonlyArray<readonly [string, BadgeKind, string]> = [
    ["h-lid", lid === "open" ? "ok" : cl ? "ac" : "t3", lidS(lid)],
    ["h-pwr", bk, pwrS(pwr, bp0)],
    ["h-thm", thK, thL],
    ["h-grd", grK, grL],
  ];
  for (const [id, k, x] of heroRows) {
    sda($(id + "-d"), "k", k);
    tx(id, x);
  }
  vis("hbb", bp0 != null);
  const hbf = $("hbf");
  if (hbf) {
    sda(hbf, "k", bk);
    hbf.style.width = `${bp}%`;
  }

  const asl = !!(disp.confirmedAsleep ?? disp.asleep);
  const rst = tr("d4", { n: rest });
  setBg("bt", cl ? I.d0 : asl ? I.r3 : "", cl ? "ac" : "in");
  patchBright(bV, canT && dispOk, dispOk);
  const cap = !dispOk
    ? I.d1
    : cl
      ? `${disp.internalOffline || asl ? I.d2 : I.d3} · ${rst}`
      : asl
        ? `${I.r3} · ${rst}`
        : !gOff(d) && d.guardStatus === "thermal_cap"
          ? I.d5
          : "";
  vis("bc", cap);

  const gOn = !gOff(d);
  for (const id of ["guard-btn", "cg"]) {
    const g = $(id) as HTMLButtonElement | null;
    if (g) {
      g.disabled = !canT;
      sda(g, "on", gOn);
      sa(g, AC, gOn);
      if (id === "guard-btn") sda(g, "ps", grP);
    }
  }
  const rail = $("mode-rail");
  if (rail) {
    rail.style.setProperty("--idx", "" + M.max(0, MD.indexOf(ov as (typeof MD)[number])));
    for (const b of qa("[data-m]")) {
      const sel = da(b, "m") === ov;
      (b as HTMLButtonElement).disabled = !canT;
      sa(b, AC, sel);
      b.tabIndex = canT && sel ? 0 : -1;
    }
  }
  setBg(
    "mb",
    p.modeSource === "manual" ? I.b7 : prof !== "normal" ? pL0 : "",
    p.modeSource === "manual" ? "ac" : prof === "strict" ? "er" : "wn"
  );
  const tot = num(ct0.total, 8);
  const jobs = num(p.maxJobs, tot);
  const fi = describeFanState(d.fan, lang, grP);
  vis("ar", (s.maxJobsOverride ?? 0) > 0);
  dis("ar", !canT);
  dis("jd", !canT || jobs <= 1);
  dis("ji", !canT || jobs >= tot);
  setBg("fth", thL, thK);
  vis("frow2", fi.showController);
  if (fi.showController) {
    tx("fctrl", fi.controller);
    setBg("fown", fi.badgeText, fi.badgeKind, fi.tooltip);
  }
  const pC = num(ct0.performanceCores);
  const eC = num(ct0.efficiencyCores);
  const het = pC > 0;
  const topo = het ? `${pC}P+${eC}E` : tr("d7", { n: tot });
  const memP = clampPercent(rm.usedPct);
  const up = tr("d6", { dur: fmtDur(h.uptimeSeconds, lang) });
  const ld = (h.loadAvg || []).map((v) => num(v).toFixed(2)).join(" · ");
  const mv = h.macosVersion && h.macosVersion !== "macOS" ? `macOS ${h.macosVersion}` : "macOS";

  const textUpdates: ReadonlyArray<readonly [string, string]> = [
    ["hs", `${lidS(lid)} · ${pwrS(pwr, bp0)} · ${pL0}`],
    ["bc", cap],
    ["gs", describeGuardStatus(d, rest, lang)],
    ["sv", (s.maxJobsOverride ?? 0) > 0 ? (jobs === 1 ? I.d9 : tr("d8", { n: jobs })) : tr("da", { n: jobs })],
    ["frpm", fi.rpmText],
    ["fcap", fi.caption],
    ["tp", `${topo} · ${tr("db", { n: memP })} · ${thL}`],
    ["dmu", num(rm.usedGb).toFixed(1)],
    ["dmt", `/ ${num(rm.totalGb).toFixed(1)} GB (${memP}%)`],
    ["dc", `${topo} · ${tr("dc", { n: num(rm.compressedGb).toFixed(1) })}`],
    ["dld", `${I.dd} ${ld || "-"}`],
    ["dsp", d.cpuSpeedLimitPct != null ? `${tr("de", { n: num(d.cpuSpeedLimitPct, 100) })} · ${up}` : up],
    ["ds", d.clamshellCausesSleep === "no" ? I.df : d.clamshellCausesSleep === "yes" ? I.dg : "—"],
    ["dlm", `${I.dh}${lang === "zh-CN" ? "" : " "}${d.lowPowerMode == 1 ? I.di : d.lowPowerMode == 0 ? I.dj : "—"}`],
    ["dhi", `${h.hostname || "Mac"} · ${h.chip || "Mac"} · ${mv}`],
    ["cp", sp || "~/…/settings.json"],
  ];
  for (const [id, v] of textUpdates) tx(id, v);

  const dmf = $("dmf");
  if (dmf) {
    sda(dmf, "k", memP >= 85 ? "er" : memP >= 60 ? "wn" : "ok");
    dmf.style.width = `${memP}%`;
  }
  patchEnv(d, prof, het, p.niceLevel ?? 0);
  vis("ce", d.settingsError);
  for (const [, , a, vals, key, isN] of CFG) {
    if (vals) {
      const rawVal = key ? s[key] : undefined;
      const val = a === "cl" ? s.lang || "auto" : "" + (isN ? num(rawVal) : rawVal || "utility");
      for (const b of qa(`[data-${a}]`)) {
        (b as HTMLButtonElement).disabled = !canT;
        sa(b, AC, da(b, a) === val);
      }
    }
  }
  const dh = $("dh");
  if (dh) dh.title = sp;
  patchChrome();
}

async function rpc(name: string, args: Record<string, unknown>, track = true): Promise<PanelSnapshot> {
  const t0 = performance.now();
  let res: ToolCallResult;
  try {
    res = await app.callServerTool({ name, arguments: args });
  } catch (err) {
    const e: RpcError = err instanceof Error ? err : new Error(String(err));
    e.isBridge = true;
    throw e;
  }
  const sc = res?.structuredContent as (PanelSnapshot & { errorKind?: string; errorDetail?: string }) | undefined;
  const contentText = Array.isArray(res?.content)
    ? (res.content[0] as { text?: string } | undefined)?.text
    : undefined;
  if (res?.isError || !sc) {
    const err: RpcError = new Error(contentText || "RPC error");
    if (sc?.errorKind) err.errorKind = sc.errorKind;
    if (sc?.errorDetail) err.errorDetail = sc.errorDetail;
    throw err;
  }
  if (track) {
    poller.recordExternalRpc({
      totalMs: M.round(performance.now() - t0),
      serverMs: sc.serverMs ?? 0,
      markSuccess: true,
    });
    onOk();
  }
  return sc;
}

const poller = createAdaptivePoller<PanelSnapshot>({
  defaultEnabled: false,
  pauseWhenHidden: true,
  shouldSkipBackgroundPoll: () => !canT || syncing || bSync || drag || inF,
  onMetrics: (m) => {
    netM = m;
    patchChrome();
  },
  fetcher: async ({ force, reason }) => {
    if (!canT) return null;
    const seq = ++pollSeq;
    if (force) {
      loading = true;
      ct(busyT);
      busyT = st(() => {
        if (loading) {
          spin = true;
          patchChrome();
        }
      }, 150);
    }
    try {
      const sc = await rpc(
        "clamshell_refresh",
        { force: !!force, ...(force ? { fresh: true } : {}), ...(hash ? { ifHash: hash } : {}) },
        false
      );
      if (seq !== pollSeq) return null;
      onOk();
      applyData(sc);
      sc.unchanged ? patchChrome() : patchAll(cur);
      return sc;
    } catch (err) {
      if (seq !== pollSeq) return null;
      onFail(reason);
      if (!cur) showEmpty({ sp: exErr(err, "e0"), r: 1 });
      else if (reason === "manual") setErr(err, "e0", () => void refreshNow(true));
      throw err;
    } finally {
      if (force) {
        ct(busyT);
        loading = spin = false;
        patchChrome();
      }
    }
  },
});

const bCtrl = createBrightnessController<PanelSnapshot>({
  setter: (percent) => {
    pollSeq += 1;
    return rpc("clamshell_set_brightness", { percent });
  },
  onOptimistic: (p) => {
    optB = p;
    patchBright(p, canT, true);
  },
  onSyncChange: (s) => {
    bSync = s;
    patchFb();
  },
  onCommit: (sc, target) => {
    pollSeq += 1;
    optB = null;
    if (sc) applyData(sc);
    const a = sc?.brightnessAction;
    const isT = a?.mode === "saved_target";
    patchAll(cur);
    setOk(isT ? "s3" : "s4", { n: isT ? a?.savedPercent ?? target : a?.percent ?? target });
  },
  onRollback: (err, target) => {
    optB = null;
    const ok = hasD(cur);
    patchBright(effB(cur) ?? 20, canT && ok, ok);
    setErr(err, "e1", () => void setB(target));
  },
});

const setB = (v: number, imm = true): Promise<void> | undefined => bCtrl.schedule(v, { immediate: imm });
const refreshNow = (force = true): Promise<PanelSnapshot | null> =>
  canT ? poller.trigger({ force, reason: force ? "manual" : "poll" }).catch(() => null) : Promise.resolve(null);

async function lockNow(): Promise<void> {
  if (locking || !canT) return;
  locking = true;
  patchChrome();
  try {
    const r = (await rpc("clamshell_lock_screen", {})) as PanelSnapshot & { verified?: boolean };
    setOk(r?.verified === false ? "s5" : "s6");
  } catch (e) {
    setErr(e, "e2", () => void lockNow());
  } finally {
    locking = false;
    patchChrome();
  }
}

async function flushQ(): Promise<void> {
  if (inF || !pend) return;
  inF = syncing = true;
  patchFb();
  try {
    while (pend) {
      const patch: Partial<SettingsState> = pend;
      const g = gen;
      pend = null;
      try {
        pollSeq += 1;
        const sc = await rpc("clamshell_configure", patch as Record<string, unknown>);
        pollSeq += 1;
        conf = sc;
        if (sc.hash) hash = sc.hash;
        syncSnap(sc);
        saveSnap(sc);
        const ok = g === gen && !pend;
        cur = ok ? sc : cur?.settings ? computeOptimisticState(sc, cur.settings) : sc;
        if (ok) {
          patchAll(cur);
          setOk("s1");
          if (cfgO) {
            tx("co", `✓ ${I.s1}`);
            vis("co", 1);
            ct(cfgT);
            cfgT = st(() => vis("co", 0), 2200);
          }
        }
      } catch (err) {
        if (pend) {
          pend = { ...patch, ...(pend as Partial<SettingsState>) };
          continue;
        }
        cur = conf;
        patchAll(cur);
        setErr(err, "e3", () => queueCfg(patch));
        break;
      }
    }
  } finally {
    inF = false;
    syncing = !!pend;
    patchFb();
    if (pend) void flushQ();
  }
}

const queueCfg = (p: Partial<SettingsState>): void => {
  gen += 1;
  pend = { ...(pend || {}), ...p };
  syncing = true;
  if (cur) {
    cur = computeOptimisticState(cur, p);
    patchAll(cur);
  }
  void flushQ();
};

const syncCtx = (c: HostContext | null | undefined): void => {
  const loc = typeof c?.locale === "string" ? c.locale : null;
  if (loc && loc !== hostLoc) {
    hostLoc = loc;
    if (!storeL() && !cur?.settings?.lang) {
      const n = resL(null, cur?.locale);
      if (n !== lang) {
        lang = n;
        patchI18n();
        if (cur) patchAll(cur);
        else {
          renderEmp();
          patchChrome();
        }
      }
    }
  }
};

const setLang = (ch: string): void => {
  const nl = ch === "auto" ? null : ch;
  storeL(nl);
  lastSL = nl;
  lang = (nl as PanelLang | null) || resL(null, null);
  patchI18n();
  if (cur) patchAll(cur);
  else {
    renderEmp();
    patchChrome();
  }
  if (canT) queueCfg({ lang: ch });
};

const pctPtr = (trk: HTMLElement, x: number): number => {
  const r = trk.getBoundingClientRect();
  return r.width ? clampPercent(((x - r.left) / r.width) * 100) : effB(cur) ?? 20;
};

on(root, "click", (e: MouseEvent) => {
  const b = cS(e, "button") as HTMLButtonElement | null;
  if (!b || b.disabled) return;
  const a = da(b, "a");
  if (a === "refresh" || a === "bnr-retry") {
    if (app.isConnected()) {
      if (canT) void refreshNow(true);
    } else {
      void connectHost(true);
    }
    return;
  }
  if (a === "bnr-dismiss") {
    bnrX = true;
    patchBnr();
    return;
  }
  if (a === "retry") {
    fb?.retry?.();
    return;
  }
  if (a === "fb-det" || a === "bnr-det" || a === "emp-det") {
    const k = a.slice(0, -4);
    rawS = rawS === k ? "" : k;
    if (k === "fb") patchFb();
    else if (k === "bnr") patchBnr();
    else renderEmp();
    return;
  }
  if (a === "cfg" || a === "cx") {
    cfgO = a === "cfg" ? !cfgO : false;
    patchChrome();
    return;
  }
  if (a === "cp") {
    const p = $("cp")?.textContent;
    if (!p) return;
    const ok = (): void => {
      cpOk = true;
      tx("cb", `✓ ${I.cb}`);
      ct(cpT);
      cpT = st(() => {
        cpOk = false;
        tx("cb", I.ca);
      }, 2e3);
    };
    if (typeof navigator < "u" && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(p).then(ok, ok);
    } else {
      ok();
    }
    return;
  }
  const lg = da(b, "lg");
  if (lg && lg !== lang) {
    setLang(lg);
    return;
  }
  const cl = da(b, "cl");
  if (cl) {
    setLang(cl);
    return;
  }
  if (!canT) return;
  if (a === "lock") {
    void lockNow();
    return;
  }
  if (a === "auto") {
    poller.setEnabled((autoW = !poller.getMetrics().enabled));
    return;
  }
  if (a === "guard") {
    queueCfg({ guardEnabled: gOff(cur) });
    return;
  }
  if (a === "jauto") {
    queueCfg({ maxJobsOverride: 0 });
    return;
  }
  const bs = da(b, "bs");
  if (bs !== null) {
    void setB(clampPercent((effB(cur) ?? 20) + +bs));
    return;
  }
  const br = da(b, "br");
  if (br !== null) {
    void setB(+br);
    return;
  }
  const js = da(b, "js");
  if (js !== null) {
    const tot = num(cur?.cpuTopology?.total, 8);
    queueCfg({ maxJobsOverride: M.max(1, M.min(tot, num(cur?.policy?.maxJobs, tot) + +js)) });
    return;
  }
  const dm = da(b, "m");
  if (dm) {
    queueCfg({ modeOverride: dm });
    return;
  }
  for (const [, , at, , key, isN] of CFG) {
    if (key) {
      const v = da(b, at);
      if (v !== null) {
        queueCfg({ [key]: isN ? +v : v } as Partial<SettingsState>);
        return;
      }
    }
  }
});

on(root, "pointerdown", (e: PointerEvent) => {
  if (e.button && e.button !== 0) return;
  const trk = cS(e, "#bright-track");
  if (!trk || ga(trk, AD) === "true") return;
  drag = true;
  sda(trk, "drag", "true");
  trk.setPointerCapture?.(e.pointerId);
  void setB(pctPtr(trk, e.clientX), false);
});

on(root, "pointermove", (e: PointerEvent) => {
  const trk = drag ? $("bright-track") : null;
  if (trk) void setB(pctPtr(trk, e.clientX), false);
});

const endDrag = (e?: PointerEvent): void => {
  if (!drag) return;
  drag = false;
  const trk = $("bright-track");
  trk?.removeAttribute("data-drag");
  if (trk && e?.clientX != null) void setB(pctPtr(trk, e.clientX));
  else void bCtrl.flush();
  if (defr && cur) patchAll(cur);
};
on(window, PU, endDrag);
on(window, PC, () => endDrag());

on(root, "keydown", (e: KeyboardEvent) => {
  if (e.key === "Escape") {
    if (cfgO) {
      cfgO = false;
      patchChrome();
      $("cfg-btn")?.focus();
      e.preventDefault();
    } else {
      const dt = $("diag-tray") as HTMLDetailsElement | null;
      if (dt?.open) {
        dt.open = false;
        dt.querySelector("summary")?.focus();
        e.preventDefault();
      }
    }
    return;
  }
  const tgt = e.target as HTMLElement | null;
  if (tgt?.id === "bright-track") {
    if (ga(tgt, AD) === "true") return;
    const c = effB(cur) ?? 20;
    const s = e.shiftKey ? 10 : 1;
    const d = (
      {
        [AR]: s,
        ArrowUp: s,
        [AL]: -s,
        ArrowDown: -s,
        PageUp: 10,
        PageDown: -10,
        Home: -c,
        End: 100 - c,
      } as Record<string, number | undefined>
    )[e.key];
    if (d !== undefined) {
      e.preventDefault();
      void setB(clampPercent(c + d), false);
    }
    return;
  }
  const dir = e.key === AR ? 1 : e.key === AL ? -1 : 0;
  if (!dir || !canT) return;
  const mb = cS(e, "[data-m]");
  const pb = cS(e, "[data-br]");
  if (mb) {
    e.preventDefault();
    const mVal = da(mb, "m") as (typeof MD)[number] | null;
    const n = MD[(MD.indexOf(mVal ?? "auto") + dir + 5) % 5];
    queueCfg({ modeOverride: n });
    q1(`[data-m="${n}"]`)?.focus();
  } else if (pb) {
    e.preventDefault();
    const bVal = +(da(pb, "br") ?? 0) as (typeof PR)[number];
    const n = PR[(PR.indexOf(bVal) + dir + 5) % 5];
    void setB(n);
    q1(`[data-br="${n}"]`)?.focus();
  }
});

const detach = attachRevealRefresh({
  doc,
  win: window,
  target: docEl,
  poller,
  onReveal: (r) => canT && poller.forceNow(r).catch(NOOP),
});

app.ontoolinput = () => {
  if (!cur) {
    loading = true;
    showEmpty({ k: "r1" });
  }
};

app.ontoolresult = (r) => {
  const sc = r?.structuredContent as PanelSnapshot | undefined;
  if (!sc || typeof sc !== "object" || (!sc.unchanged && !sc.policy && !sc.host)) return;
  pollSeq += 1;
  const prev = hash;
  const had = !!cur;
  onOk();
  applyData(sc);
  loading = false;
  if (canT) poller.markInitialBoot();
  had && (sc.unchanged || (sc.hash && sc.hash === prev)) ? patchChrome() : patchAll(cur);
};

app.onhostcontextchanged = (ctx) => {
  syncCtx(ctx);
  if (canT && (ctx?.containerDimensions || ctx?.displayMode) && !drag && !bSync) {
    void poller.forceNow("host-context").catch(NOOP);
  }
};

app.onteardown = () => {
  ct(busyT);
  ct(fbT);
  ct(cfgT);
  ct(cpT);
  detach();
  poller.destroy();
  bCtrl.destroy();
  window.removeEventListener(PU, endDrag);
  return {};
};

async function connectHost(manual = false): Promise<void> {
  try {
    await app.connect();
    canT = app.hasServerTools();
    syncCtx(app.getHostContext());
    onOk();
    if (canT) {
      if (autoW) poller.setEnabled(true);
      if (cur) poller.markInitialBoot(boot && !useCached && typeof boot.bootTs === "number" ? boot.bootTs : undefined);
    } else {
      poller.setEnabled(false);
    }
    if (cur) patchAll(cur);
    else {
      renderEmp();
      patchChrome();
    }
    if (canT) {
      const freshBoot =
        !useCached &&
        !!boot &&
        !boot.stale &&
        typeof boot.bootTs === "number" &&
        Date.now() - boot.bootTs < 2500;
      if (manual) await refreshNow(true);
      else if (!freshBoot && (useCached || boot?.stale || (boot && typeof boot.bootTs === "number"))) {
        void poller.trigger({ force: false, reason: "swr" }).catch(NOOP);
      } else if (!cur) {
        st(() => {
          if (!cur) void refreshNow(true);
        }, 150);
      }
    }
  } catch (e) {
    canT = false;
    loading = first = false;
    poller.setEnabled(false);
    const raw = e instanceof Error ? e.message : "" + (e || "");
    if (!cur) showEmpty({ sp: { br: raw, raw }, r: 1 });
    else {
      bnrE = { key: "b0", raw };
      bnrX = false;
      if (rawS === "bnr") rawS = "";
      patchAll(cur);
    }
  }
}

(() => {
  mount();
  patchI18n();
  if (initSnap) {
    syncSnap(initSnap);
    patchAll(initSnap);
    if (boot && !useCached) saveSnap(boot);
  } else {
    showEmpty({ k: "r1" });
  }
  void connectHost(false);
})();
