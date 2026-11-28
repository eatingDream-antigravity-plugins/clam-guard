import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  BG_POLL_INTERVAL_FAST_MS,
  BG_POLL_INTERVAL_MED_MS,
  BG_POLL_INTERVAL_SLOW_MS,
  BG_POLL_INTERVAL_ULTRA_SLOW_MS,
  POINTER_STALE_MS,
  POLL_INTERVAL_FAST_MS,
  POLL_INTERVAL_MAX_BACKOFF_MS,
  POLL_INTERVAL_MED_MS,
  POLL_INTERVAL_SLOW_MS,
  POLL_INTERVAL_ULTRA_SLOW_MS,
  REVEAL_THROTTLE_MS,
  attachRevealRefresh,
  computeAdaptiveIntervalMs,
  createAdaptivePoller,
} from "../polling.ts";
import {
  BRIGHTNESS_DEBOUNCE_MS,
  clampPercent,
  createBrightnessController,
} from "../brightness.ts";
import { App, applyHostStyleVariables, parseColorLum } from "../kit/bridge.ts";
import type { BridgeMessageEvent, BridgeTargetWindow, BridgeWindow } from "../kit/bridge.ts";
import { assertI18nParity, assertEnNoCjk, assertPanelInvariants } from "../kit/guard.ts";
import {
  I18N,
  computeOptimisticState,
  describeFanState,
  describeGuardStatus,
  resolvePanelLang,
} from "../model.ts";
import type { PanelSnapshot } from "../model.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PANEL_DIR = path.resolve(__dirname, "..");

const FAMILY_TOKENS = [
  "--bg", "--s1", "--s2", "--s0", "--t1", "--t2", "--t3",
  "--ln", "--l2", "--sh", "--ac", "--ah", "--ok", "--wn", "--er", "--in",
];

interface FakeElement {
  id: string;
  disabled: boolean;
  hidden: boolean;
  tabIndex: number;
  className: string;
  title: string;
  style: { setProperty(): void; backgroundColor: string; colorScheme: string; width: string };
  lastElementChild: FakeElement | null;
  _textWrites?: number;
  _children?: unknown[];
  textContent: string;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  removeAttribute(k: string): void;
  appendChild(c: unknown): unknown;
  replaceChildren(...nodes: unknown[]): void;
  addEventListener(t: string, fn: (ev?: unknown) => void): void;
  removeEventListener(t: string, fn: (ev?: unknown) => void): void;
  dispatch(t: string, ev?: unknown): void;
  querySelector(sel: string): FakeElement | null;
  querySelectorAll(): FakeElement[];
  getBoundingClientRect(): { width: number; height: number; left: number };
}

describe("Clam Guard Panel: Adaptive Polling, Brightness Coalescing, Fan Ownership & Lucid Indigo UI", () => {
  it("adapts interval from net RTT in foreground and continues background polling when hidden", async () => {
    assert.equal(computeAdaptiveIntervalMs({ rttMs: 40, hidden: false }), POLL_INTERVAL_FAST_MS);
    assert.equal(computeAdaptiveIntervalMs({ rttMs: 220, hidden: false }), POLL_INTERVAL_MED_MS);
    assert.equal(computeAdaptiveIntervalMs({ rttMs: 450, hidden: false }), POLL_INTERVAL_SLOW_MS);
    assert.equal(computeAdaptiveIntervalMs({ rttMs: 950, hidden: false }), POLL_INTERVAL_ULTRA_SLOW_MS);

    assert.equal(computeAdaptiveIntervalMs({ rttMs: 40, hidden: true }), BG_POLL_INTERVAL_FAST_MS);
    assert.equal(computeAdaptiveIntervalMs({ rttMs: 220, hidden: true }), BG_POLL_INTERVAL_MED_MS);
    assert.equal(computeAdaptiveIntervalMs({ rttMs: 450, hidden: true }), BG_POLL_INTERVAL_SLOW_MS);
    assert.equal(computeAdaptiveIntervalMs({ rttMs: 950, hidden: true }), BG_POLL_INTERVAL_ULTRA_SLOW_MS);
    assert.equal(
      computeAdaptiveIntervalMs({ rttMs: 450, consecutiveErrors: 4, hidden: false }),
      POLL_INTERVAL_MAX_BACKOFF_MS
    );

    let hidden = false;
    let wallClock = 10_000;
    let perfClock = 1000;
    let tid = 1;
    const timers = new Map<number, { fn: () => void; ms: number }>();
    const fetchCalls: Array<{ force: boolean; reason: string }> = [];
    let pending: ((res: { unchanged?: boolean; serverMs?: number }, deltaMs: number) => void) | null = null;

    const poller = createAdaptivePoller<{ unchanged?: boolean; serverMs?: number }, number>({
      isHidden: () => hidden,
      now: () => wallClock,
      perfNow: () => perfClock,
      setTimer: (fn, ms) => {
        const id = tid++;
        timers.set(id, { fn, ms });
        return id;
      },
      clearTimer: (id) => {
        timers.delete(id);
      },
      fetcher: (opts) => {
        fetchCalls.push(opts);
        return new Promise((resolve) => {
          pending = (res, deltaMs) => {
            perfClock += deltaMs;
            wallClock += deltaMs;
            resolve(res);
          };
        });
      },
    });

    poller.setEnabled(true);
    const p1 = poller.trigger({ force: false, reason: "poll" });
    const p2 = poller.trigger({ force: false, reason: "poll" });
    assert.equal(p1, p2);
    assert.equal(fetchCalls.length, 1);

    (pending as ((res: { unchanged?: boolean; serverMs?: number }, deltaMs: number) => void) | null)?.(
      { unchanged: true, serverMs: 12 },
      462
    );
    await p1;
    assert.equal(poller.getMetrics().lastNetRttMs, 450);
    assert.equal(poller.getMetrics().currentIntervalMs, POLL_INTERVAL_SLOW_MS);

    hidden = true;
    poller.handleVisibilityChange(true);
    assert.equal(timers.size, 1);
    const [bgTimerId, bgTimer] = [...timers.entries()][0];
    assert.equal(bgTimer.ms, BG_POLL_INTERVAL_SLOW_MS);
    assert.equal(poller.getMetrics().inBackground, true);

    timers.delete(bgTimerId);
    bgTimer.fn();
    assert.equal(fetchCalls.length, 2);
    assert.deepEqual(fetchCalls[1], { force: false, reason: "poll" });
    (pending as ((res: { unchanged?: boolean; serverMs?: number }, deltaMs: number) => void) | null)?.(
      { unchanged: false, serverMs: 5 },
      35
    );
    await new Promise((r) => setImmediate(r));
    assert.equal(timers.size, 1);

    hidden = false;
    wallClock += 500;
    poller.handleVisibilityChange(false);
    assert.equal(fetchCalls.length, 3);
    assert.deepEqual(fetchCalls[2], { force: true, reason: "visibility" });
    (pending as ((res: { unchanged?: boolean; serverMs?: number }, deltaMs: number) => void) | null)?.(
      { unchanged: false, serverMs: 5 },
      25
    );
    await new Promise((r) => setImmediate(r));
    assert.equal(timers.size, 1);
    poller.destroy();
  });

  it("triggers instant fresh reveal refresh with 250ms throttle across observers & events and disconnects cleanly", async () => {
    let wallClock = 10_000;
    const hidden = false;
    const calls: Array<{ force: boolean; reason: string }> = [];
    const poller = createAdaptivePoller<{ unchanged?: boolean; serverMs?: number }, number>({
      isHidden: () => hidden,
      now: () => wallClock,
      perfNow: () => wallClock,
      setTimer: () => 1,
      clearTimer: () => {},
      fetcher: async (opts) => {
        calls.push(opts);
        return { unchanged: true, serverMs: 2 };
      },
    });
    poller.markInitialBoot(wallClock);

    let roCb: ((entries: ReadonlyArray<{ contentRect?: { width: number; height: number } }>) => void) | null = null;
    let roDisconnected = false;
    class FakeResizeObserver {
      constructor(cb: (entries: ReadonlyArray<{ contentRect?: { width: number; height: number } }>) => void) {
        roCb = cb;
      }
      observe(): void {}
      disconnect(): void {
        roDisconnected = true;
      }
    }

    let ioCb: ((entries: ReadonlyArray<{ isIntersecting?: boolean }>) => void) | null = null;
    let ioOpts: { threshold?: number } | undefined;
    let ioDisconnected = false;
    class FakeIntersectionObserver {
      constructor(
        cb: (entries: ReadonlyArray<{ isIntersecting?: boolean }>) => void,
        opts?: { threshold?: number }
      ) {
        ioCb = cb;
        ioOpts = opts;
      }
      observe(): void {}
      disconnect(): void {
        ioDisconnected = true;
      }
    }

    interface ListenerEntry {
      fn: () => void;
      opts?: boolean | AddEventListenerOptions;
    }

    const mkEmitter = () => {
      const map = new Map<string, ListenerEntry[]>();
      return {
        addEventListener(type: string, fn: () => void, opts?: boolean | AddEventListenerOptions): void {
          if (!map.has(type)) map.set(type, []);
          map.get(type)!.push({ fn, opts });
        },
        removeEventListener(type: string, fn: () => void): void {
          map.set(
            type,
            (map.get(type) || []).filter((e) => e.fn !== fn)
          );
        },
        emit(type: string): void {
          for (const e of map.get(type) || []) e.fn();
        },
        listeners(type: string): ListenerEntry[] {
          return map.get(type) || [];
        },
      };
    };

    const doc = Object.assign(mkEmitter(), {
      get hidden(): boolean {
        return hidden;
      },
    });
    const win = mkEmitter();
    let rect = { width: 0, height: 0 };
    const target = Object.assign(mkEmitter(), { getBoundingClientRect: () => rect });

    const detach = attachRevealRefresh({
      doc,
      win,
      target,
      poller,
      ResizeObserverCtor: FakeResizeObserver,
      IntersectionObserverCtor: FakeIntersectionObserver,
    });

    assert.deepEqual(ioOpts, { threshold: 0 });
    const pointerOpts = target.listeners("pointerenter")[0]?.opts;
    assert.equal(typeof pointerOpts === "object" && pointerOpts !== null ? pointerOpts.passive : undefined, true);

    rect = { width: 380, height: 640 };
    (roCb as ((entries: ReadonlyArray<{ contentRect?: { width: number; height: number } }>) => void) | null)?.([
      { contentRect: rect },
    ]);
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { force: true, reason: "resize" });

    wallClock += REVEAL_THROTTLE_MS - 50;
    win.emit("focus");
    win.emit("pageshow");
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 1);

    wallClock += 100;
    (ioCb as ((entries: ReadonlyArray<{ isIntersecting?: boolean }>) => void) | null)?.([{ isIntersecting: false }]);
    (ioCb as ((entries: ReadonlyArray<{ isIntersecting?: boolean }>) => void) | null)?.([{ isIntersecting: true }]);
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], { force: true, reason: "intersection" });

    wallClock += POINTER_STALE_MS - 100;
    target.emit("pointerenter");
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 2);

    wallClock += 200;
    target.emit("pointerenter");
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[2], { force: true, reason: "pointerenter" });

    detach();
    assert.equal(roDisconnected, true);
    assert.equal(ioDisconnected, true);
    assert.equal(doc.listeners("visibilitychange").length, 0);
    assert.equal(win.listeners("focus").length, 0);
    assert.equal(win.listeners("pageshow").length, 0);
    assert.equal(target.listeners("pointerenter").length, 0);
    poller.destroy();
  });

  it("debounces 250ms drag events, coalesces single-flight last-write-wins, and rolls back on error", async () => {
    assert.equal(clampPercent(-5), 0);
    assert.equal(clampPercent(150), 100);

    const timers = new Map<number, { fn: () => void; ms: number }>();
    let tid = 1;
    const sent: number[] = [];
    const committed: Array<{ res: unknown; p: number }> = [];
    const rollbacks: string[] = [];
    const resolvers: Array<{ resolve: (v: unknown) => void; reject: (e: Error) => void }> = [];

    const ctrl = createBrightnessController({
      debounceMs: BRIGHTNESS_DEBOUNCE_MS,
      setTimer: (fn, ms) => {
        const id = tid++;
        timers.set(id, { fn, ms });
        return id;
      },
      clearTimer: (id) => {
        timers.delete(id);
      },
      onCommit: (res, p) => committed.push({ res, p }),
      onRollback: (err) => rollbacks.push(err instanceof Error ? err.message : String(err)),
      setter: (pct) => {
        sent.push(pct);
        return new Promise((resolve, reject) => resolvers.push({ resolve, reject }));
      },
    });

    ctrl.schedule(10);
    ctrl.schedule(40);
    ctrl.schedule(70);
    assert.equal(sent.length, 0);
    const [entry] = [...timers.values()];
    timers.clear();
    entry.fn();
    assert.deepEqual(sent, [70]);

    void ctrl.schedule(20, { immediate: true });
    void ctrl.schedule(90, { immediate: true });
    assert.deepEqual(sent, [70]);

    resolvers.shift()!.resolve({ ok: true });
    await new Promise((r) => setImmediate(r));
    assert.equal(committed.length, 0);
    assert.deepEqual(sent, [70, 90]);

    resolvers.shift()!.resolve({ ok: true });
    await new Promise((r) => setImmediate(r));
    assert.equal(committed.length, 1);
    assert.equal(committed[0].p, 90);

    void ctrl.schedule(100, { immediate: true });
    resolvers.shift()!.reject(new Error("boom"));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(rollbacks, ["boom"]);
    assert.equal(ctrl.isSyncing(), false);

    // P1 #9: if an older in-flight write fails while a newer target is queued,
    // the newer target MUST still be flushed and committed without stranding isSyncing().
    void ctrl.schedule(20, { immediate: true });
    void ctrl.schedule(80, { immediate: true });
    assert.deepEqual(sent.slice(-1), [20]);
    resolvers.shift()!.reject(new Error("stale-fail"));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(sent.slice(-2), [20, 80]);
    assert.deepEqual(rollbacks, ["boom"]);
    resolvers.shift()!.resolve({ ok: true });
    await new Promise((r) => setImmediate(r));
    assert.equal(committed[committed.length - 1].p, 80);
    assert.equal(ctrl.isSyncing(), false);
    ctrl.destroy();
  });

  it("ignores transparent or low-alpha --color-background-primary host vars and returns null luminance", () => {
    const props = new Map<string, string>();
    const fakeEl = {
      style: {
        setProperty: (k: string, v: string) => {
          props.set(k, v);
        },
      },
    };

    applyHostStyleVariables(
      {
        "--color-background-primary": "",
        "--color-text-primary": "#F2F4F8",
      },
      fakeEl
    );
    assert.equal(props.has("--color-background-primary"), false);
    assert.equal(props.get("--color-text-primary"), "#F2F4F8");

    for (const badBg of [
      "transparent",
      "TRANSPARENT",
      "rgba(0, 0, 0, 0)",
      "rgba(11, 13, 18, 0.5)",
      "rgba(255, 255, 255, 0.89)",
      "rgb(0 0 0 / 0)",
      "rgb(0 0 0 / 40%)",
      "#0B0D1200",
      "#0B0D1280",
      "#0000",
      "hsla(0, 0%, 0%, 0)",
      "color-mix(in srgb, transparent 50%, black)",
      "var(--unknown-bg)",
      "currentColor",
      "red",
      "   ",
    ]) {
      applyHostStyleVariables({ "--color-background-primary": badBg }, fakeEl);
      assert.equal(
        props.has("--color-background-primary"),
        false,
        `expected ${JSON.stringify(badBg)} to be ignored`
      );
    }

    applyHostStyleVariables({ "--color-background-primary": "black" }, fakeEl);
    assert.equal(props.get("--color-background-primary"), "black");
    applyHostStyleVariables({ "--color-background-primary": "white" }, fakeEl);
    assert.equal(props.get("--color-background-primary"), "white");

    applyHostStyleVariables({ "--color-background-primary": "rgba(11, 13, 18, 0.95)" }, fakeEl);
    assert.equal(props.get("--color-background-primary"), "rgba(11, 13, 18, 0.95)");

    applyHostStyleVariables({ "--color-background-primary": "#0B0D12" }, fakeEl);
    assert.equal(props.get("--color-background-primary"), "#0B0D12");

    assert.equal(parseColorLum("transparent"), null);
    assert.equal(parseColorLum("rgba(0, 0, 0, 0)"), null);
    assert.equal(parseColorLum("rgba(255, 255, 255, 0.49)"), null);
    assert.equal(parseColorLum("#ffffff00"), null);
    assert.equal(parseColorLum("#ffffff40"), null);
    assert.equal(parseColorLum("#fff0"), null);
    assert.ok((parseColorLum("#0B0D12") ?? 1) < 0.2);
    assert.ok((parseColorLum("#0B0D12ff") ?? 1) < 0.2);
    assert.ok((parseColorLum("#F8FAFD") ?? 0) > 0.9);
    assert.ok((parseColorLum("rgba(248, 250, 253, 0.9)") ?? 0) > 0.9);
  });

  it("built dist/panel.html satisfies all Lucid Indigo & Panel Kit hard invariants", () => {
    const html = fs.readFileSync(path.join(PANEL_DIR, "dist", "panel.html"), "utf8");
    const report = assertPanelInvariants(html, {
      maxBytes: 65_536,
      hardMaxBytes: 65_536,
      warnBytes: 57_344,
      bootPlaceholder: "/*__MAC_CLAMSHELL_BOOT__*/",
    });
    assert.ok(report.bytes < 65_536, `hard size gate failed: ${report.bytes} B >= 65536 B`);
    assertI18nParity(I18N.en, I18N.zh);
    assertEnNoCjk(I18N.en);

    // Dark-first frame 0 & CSP
    assert.ok(html.includes('<meta name="color-scheme" content="dark">'), "missing dark-only color-scheme meta");
    assert.ok(html.includes("default-src 'none'"), "missing CSP default-src 'none'");
    assert.ok(html.includes('style="background:#0B0D12;color-scheme:dark"'), "missing inline dark lock on <html>");
    assert.ok(html.includes('<body style="background:#0B0D12">'), "missing inline dark lock on <body>");
    assert.ok(!/https?:\/\/[^"'\s>]+/i.test(html.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, "")), "must contain zero external URLs");

    // Zero prefers-color-scheme, zero opacity:0 in @keyframes, zero innerHTML/outerHTML, zero --buncss-*
    assert.ok(!/prefers-color-scheme/i.test(html), "must NOT contain prefers-color-scheme");
    const keyframes = html.match(/@keyframes\s+[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/gi) || [];
    for (const kf of keyframes) {
      assert.ok(!/opacity\s*:\s*0(?:\D|$)/i.test(kf), `forbidden opacity:0 in @keyframes: ${kf}`);
    }
    assert.ok(!/\.innerHTML\s*=|\.outerHTML\s*=/i.test(html), "must NOT assign innerHTML/outerHTML");
    assert.ok(!/--buncss-/i.test(html), "must strip --buncss-* declarations");

    // Exactly one inline <script> containing boot placeholder
    const scripts = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) || [];
    assert.equal(scripts.length, 1, `expected exactly 1 <script> tag, got ${scripts.length}`);
    assert.ok(scripts[0].includes("/*__MAC_CLAMSHELL_BOOT__*/"), "missing SSR boot placeholder in single script");
    const jsBody = scripts[0].replace(/^<script[^>]*>|<\/script>$/gi, "");
    new Function(jsBody);

    // All 16 family tokens in BOTH dark (:root) and light (:root[data-theme=light])
    const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/i);
    assert.ok(styleMatch, "missing inline <style>");
    const css = styleMatch[1];
    const darkBlock = css.match(/:root\{([^}]+)\}/i);
    const lightBlock = css.match(/:root\[data-theme=["']?light["']?\]\{([^}]+)\}/i);
    assert.ok(darkBlock, "missing dark :root token block");
    assert.ok(lightBlock, "missing light :root[data-theme=light] token block");
    for (const tok of FAMILY_TOKENS) {
      assert.ok(darkBlock[1].includes(`${tok}:`), `missing dark token ${tok}`);
      assert.ok(lightBlock[1].includes(`${tok}:`), `missing light token ${tok}`);
    }
    assert.ok(/--ok:\s*#059669/i.test(lightBlock[1]), `light --ok must be #059669, got ${lightBlock[1]}`);

    // Reduced motion, structure, no duplicate #biv, Lock button out of .hd header
    assert.ok(/prefers-reduced-motion:\s*reduce/i.test(html), "missing reduced-motion support");
    assert.ok(!html.includes('id="biv"'), "duplicate brightness #biv must be removed");
    const headerMatch = html.match(/<header class="hd">[\s\S]*?<\/header>/i);
    assert.ok(headerMatch, "missing .hd header");
    assert.ok(html.includes("<title>Clam Guard</title>"), "panel.html must use spaced Title Case title");
    assert.ok(headerMatch[0].includes("Clam Guard"), "panel header must use spaced Title Case wordmark");
    assert.ok(!headerMatch[0].includes('id="lock-btn"'), "Lock Screen must be in Display card footer, not header");
    assert.ok(html.includes('id="lock-btn"'), "missing #lock-btn in Display card footer");
    assert.ok(html.includes('id="fan-card"') && html.includes('id="bnr"') && html.includes('class="card hero fl"'), "missing hero, banner, or fan card");
    assert.ok(html.includes("diag-tray") && html.includes("bright-track") && html.includes("mode-rail"), "missing progressive disclosure tray and controls");
    assert.ok(
      html.includes("clamshell_refresh") &&
        html.includes("clamshell_configure") &&
        html.includes("clamshell_set_brightness") &&
        html.includes("clamshell_lock_screen"),
      "missing expected MCP tool names"
    );
  });

  it("panel runtime updates hero, fan ownership states, data-ps paused state, disconnected banner, lock RPC, and teardown", async () => {
    const html = fs.readFileSync(path.join(PANEL_DIR, "dist", "panel.html"), "utf8");
    const m = html.match(/<script>([\s\S]+)<\/script>/);
    assert.ok(m, "missing single inline script");

    const byId = new Map<string, FakeElement>();
    const mkEl = (id = "", attrs: Record<string, string> = {}): FakeElement => {
      const attrMap = new Map(Object.entries(attrs));
      let textVal = "";
      const listeners = new Map<string, Array<(ev?: unknown) => void>>();
      const children: unknown[] = [];
      const el: FakeElement = {
        id,
        disabled: false,
        hidden: false,
        tabIndex: 0,
        className: "",
        title: "",
        style: { setProperty() {}, backgroundColor: "", colorScheme: "", width: "" },
        lastElementChild: null,
        get textContent(): string {
          return textVal;
        },
        set textContent(v: string) {
          el._textWrites = (el._textWrites || 0) + 1;
          textVal = String(v);
        },
        setAttribute(k, v) {
          attrMap.set(k, String(v));
        },
        getAttribute(k) {
          return attrMap.has(k) ? attrMap.get(k)! : null;
        },
        removeAttribute(k) {
          attrMap.delete(k);
        },
        appendChild(c) {
          children.push(c);
          return c;
        },
        replaceChildren(...nodes) {
          children.length = 0;
          children.push(...nodes);
          el._children = [...nodes];
        },
        addEventListener(t, fn) {
          if (!listeners.has(t)) listeners.set(t, []);
          listeners.get(t)!.push(fn);
        },
        removeEventListener(t, fn) {
          listeners.set(
            t,
            (listeners.get(t) || []).filter((f) => f !== fn)
          );
        },
        dispatch(t, ev) {
          for (const fn of listeners.get(t) || []) fn(ev);
        },
        querySelector(sel) {
          const idM = sel.match(/^#(.+)$/);
          return idM ? byId.get(idM[1]) || null : null;
        },
        querySelectorAll() {
          return [];
        },
        getBoundingClientRect() {
          return { width: 380, height: 600, left: 0 };
        },
      };
      if (id) byId.set(id, el);
      return el;
    };

    const appRoot = mkEl("app");
    for (const id of [
      "shell", "emp", "emp-msg", "emp-btn", "swp",
      "hd", "hs", "fb", "fb-p", "fb-d", "fb-t", "fb-r",
      "auto-chip", "auto-lbl", "lang-grp", "refresh-btn",
      "bnr", "bnr-t", "bnr-act", "bnr-x",
      "k0", "h-lid-d", "h-lid", "k1", "h-pwr-d", "h-pwr", "hbb", "hbf",
      "k2", "h-thm-d", "h-thm", "k3", "h-grd-d", "h-grd",
      "k4", "bt", "bv", "bright-track", "prs-grp", "bc", "k5", "gs", "guard-btn", "lock-btn", "k6",
      "k7", "mb", "mode-rail", "k8", "ar", "jd", "sv", "ji",
      "fan-card", "k9", "frpm", "fth", "frow2", "ka", "fctrl", "fown", "fcap",
      "diag-tray", "kb", "tp", "kc", "dmu", "dmt", "dmf", "dc",
      "kd", "dld", "dsp", "ds", "dlm", "ke", "ac-grp", "de", "dh", "dhi", "ht", "ft",
    ]) {
      const e = mkEl(id);
      if (id === "lock-btn") e.setAttribute("data-a", "lock");
      if (id === "guard-btn") e.setAttribute("data-a", "guard");
      if (id === "auto-chip") e.lastElementChild = byId.get("auto-lbl") || mkEl("auto-lbl");
    }

    const docEl = mkEl("__html");
    const bodyEl = mkEl("__body");
    let docHidden = false;
    const docListeners = new Map<string, Array<(ev?: unknown) => void>>();
    const winListeners = new Map<string, Array<(ev?: unknown) => void>>();
    const timers: Array<{ id: number; fn: () => void; ms: number; cleared: boolean }> = [];
    let tid = 1;
    const rpcCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const configureHandlers: Array<(id: unknown, args: Record<string, unknown>) => void> = [];
    let failNextRefresh = false;
    let nextPollPayload: Record<string, unknown> = {
      unchanged: true,
      hash: "h1",
      timestamp: "2026-01-01T00:00:05Z",
      serverMs: 2,
    };
    let roDisconnected = false;
    let ioDisconnected = false;

    const emitWin = (type: string, ev: unknown): void => {
      for (const fn of winListeners.get(type) || []) fn(ev);
    };

    const fakeParent = {
      postMessage(msg: { id?: unknown; method?: string; params?: { name: string; arguments: Record<string, unknown> } }): void {
        if (msg.method === "ui/initialize") {
          setImmediate(() =>
            emitWin("message", {
              source: fakeParent,
              data: {
                jsonrpc: "2.0",
                id: msg.id,
                result: {
                  protocolVersion: "2026-01-26",
                  hostCapabilities: { serverTools: {} },
                  hostContext: { theme: "dark" },
                },
              },
            })
          );
        } else if (msg.method === "tools/call" && msg.params) {
          const callParams = msg.params;
          rpcCalls.push(callParams);
          if (callParams.name === "clamshell_configure" && configureHandlers.length > 0) {
            const handler = configureHandlers.shift()!;
            handler(msg.id, callParams.arguments);
            return;
          }
          if (callParams.name === "clamshell_refresh" && failNextRefresh) {
            setImmediate(() =>
              emitWin("message", {
                source: fakeParent,
                data: {
                  jsonrpc: "2.0",
                  id: msg.id,
                  result: { isError: true, content: [{ type: "text", text: "offline" }] },
                },
              })
            );
            return;
          }
          let structuredContent: Record<string, unknown> = nextPollPayload;
          if (callParams.name === "clamshell_lock_screen") {
            structuredContent = {
              ok: true,
              method: "SACLockScreenImmediate",
              verified: true,
              status: "verified",
              locked_at_ms: 1700000000000,
              serverMs: 1,
            };
          }
          setImmediate(() =>
            emitWin("message", {
              source: fakeParent,
              data: {
                jsonrpc: "2.0",
                id: msg.id,
                result: { content: [{ type: "text", text: "ok" }], structuredContent },
              },
            })
          );
        }
      },
    };

    const boot: PanelSnapshot = {
      timestamp: "2026-01-01T00:00:00Z",
      locale: "en",
      lidState: "open",
      clamshellCausesSleep: "no",
      powerSource: "ac",
      batteryPct: 95,
      thermalState: "ok",
      thermalPressure: "nominal",
      lowPowerMode: "0",
      cpuTopology: { total: 10, performanceCores: 6, efficiencyCores: 4 },
      host: {
        hostname: "mbp",
        chip: "Apple M3",
        macosVersion: "15.4",
        uptimeSeconds: 3600,
        loadAvg: [1, 1, 1],
        memory: { usedGb: 8, totalGb: 16, compressedGb: 1, usedPct: 50 },
      },
      settings: {
        modeOverride: "auto",
        maxJobsOverride: 0,
        guardEnabled: true,
        acClosedProfile: "utility",
        bgPollIntervalSec: 6,
      },
      policy: { profile: "normal", modeSource: "auto", maxJobs: 10, niceLevel: 0 },
      envVars: {},
      display: { available: true, percent: 60, savedPercent: 60, asleep: false },
      fan: {
        status: "ok",
        fans: [
          { id: 0, label: "Left", rpm: 2140, manual: false },
          { id: 1, label: "Right", rpm: 2210, manual: false },
        ],
        controller: "System (macOS)",
        externalManagers: [],
        ownershipMode: "observer",
        readOnly: true,
        sampledAtMs: 1700000000000,
        stale: false,
        note: "Read-only observer.",
      },
      guardStatus: "armed",
      hash: "h1",
    };

    let clock = 50_000;
    class FakeDate extends Date {
      static override now(): number {
        return clock;
      }
    }

    const ctx: Record<string, unknown> = {
      window: {
        parent: fakeParent,
        innerWidth: 400,
        __MAC_CLAMSHELL_BOOT__: boot,
        addEventListener(t: string, fn: (ev?: unknown) => void) {
          if (!winListeners.has(t)) winListeners.set(t, []);
          winListeners.get(t)!.push(fn);
        },
        removeEventListener(t: string, fn: (ev?: unknown) => void) {
          winListeners.set(
            t,
            (winListeners.get(t) || []).filter((f) => f !== fn)
          );
        },
      },
      document: {
        documentElement: docEl,
        body: bodyEl,
        get hidden(): boolean {
          return docHidden;
        },
        getElementById: (id: string) => byId.get(id) || null,
        querySelector: () => null,
        createElement: (tag: string) => mkEl("", { _tag: tag }),
        createTextNode: (t: unknown) => ({ textContent: String(t) }),
        addEventListener(t: string, fn: (ev?: unknown) => void) {
          if (!docListeners.has(t)) docListeners.set(t, []);
          docListeners.get(t)!.push(fn);
        },
        removeEventListener(t: string, fn: (ev?: unknown) => void) {
          docListeners.set(
            t,
            (docListeners.get(t) || []).filter((f) => f !== fn)
          );
        },
      },
      navigator: { language: "en-US" },
      performance: { now: () => clock },
      Date: FakeDate,
      setTimeout: (fn: () => void, ms: number) => {
        const id = tid++;
        timers.push({ id, fn, ms, cleared: false });
        return id;
      },
      clearTimeout: (id: number) => {
        const t = timers.find((x) => x.id === id);
        if (t) t.cleared = true;
      },
      requestAnimationFrame: (fn: () => void) => fn(),
      ResizeObserver: class {
        observe(): void {}
        disconnect(): void {
          roDisconnected = true;
        }
      },
      IntersectionObserver: class {
        observe(): void {}
        disconnect(): void {
          ioDisconnected = true;
        }
      },
      console,
    };
    ctx.globalThis = ctx;

    vm.runInNewContext(m[1], ctx);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.equal(byId.get("h-lid")!.textContent, "Open");
    assert.equal(byId.get("frpm")!.textContent, "L 2,140 · R 2,210 rpm");
    assert.equal(byId.get("fctrl")!.textContent, "macOS (auto)");
    assert.equal(byId.get("fown")!.textContent, "Read-only");
    assert.equal(byId.get("fown")!.getAttribute("data-k"), "in");
    assert.equal(byId.get("auto-chip")!.getAttribute("data-ps"), "false");
    const writesAfterBoot = byId.get("hs")!._textWrites;

    // 1. Background poll unchanged:true -> 0 DOM churn
    docHidden = true;
    for (const fn of docListeners.get("visibilitychange") || []) fn();
    const bgTimer1 = [...timers].reverse().find((t) => !t.cleared && t.ms >= BG_POLL_INTERVAL_FAST_MS);
    assert.ok(bgTimer1, "expected background poll timer when hidden");
    bgTimer1.cleared = true;
    bgTimer1.fn();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(byId.get("hs")!._textWrites, writesAfterBoot, "unchanged poll must cause 0 DOM churn");

    // 2. Changed poll with Macs Fan Control yield + paused guard updates hero, fan card, and real data-ps!
    nextPollPayload = {
      ...boot,
      lidState: "closed",
      batteryPct: 42,
      powerSource: "battery",
      settings: { ...boot.settings, guardEnabled: false },
      guardStatus: "paused",
      fan: {
        status: "ok",
        fans: [
          { id: 0, label: "Left", rpm: 3200, manual: true },
          { id: 1, label: "Right", rpm: 3350, manual: true },
        ],
        controller: "Macs Fan Control",
        externalManagers: ["Macs Fan Control"],
        ownershipMode: "yield",
        readOnly: true,
        sampledAtMs: 1700000005000,
        stale: false,
        note: "Yields to Macs Fan Control.",
      },
      hash: "h2",
      unchanged: false,
      serverMs: 3,
    };
    const bgTimer2 = [...timers].reverse().find((t) => !t.cleared && t.ms >= BG_POLL_INTERVAL_FAST_MS);
    assert.ok(bgTimer2);
    bgTimer2.cleared = true;
    bgTimer2.fn();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(byId.get("h-lid")!.textContent, "Closed");
    assert.equal(byId.get("h-grd")!.textContent, "Paused");
    assert.equal(byId.get("auto-chip")!.getAttribute("data-ps"), "true", "data-ps must reflect real guard-paused state");
    assert.equal(byId.get("guard-btn")!.getAttribute("data-ps"), "true");
    assert.equal(byId.get("frpm")!.textContent, "L 3,200 · R 3,350 rpm");
    assert.equal(byId.get("fctrl")!.textContent, "Macs Fan Control");
    assert.equal(byId.get("fown")!.textContent, "External");
    assert.equal(byId.get("fown")!.getAttribute("data-k"), "wn");

    // 3. Fanless state hides controller row and shows passive cooling
    nextPollPayload = {
      ...boot,
      fan: {
        status: "fanless",
        fans: [],
        controller: "System (macOS)",
        externalManagers: [],
        ownershipMode: "observer",
        readOnly: true,
        sampledAtMs: 1700000010000,
        stale: false,
        note: "Fanless.",
      },
      hash: "h2b",
      unchanged: false,
      serverMs: 2,
    };
    const bgTimerFanless = [...timers].reverse().find((t) => !t.cleared && t.ms >= BG_POLL_INTERVAL_FAST_MS);
    assert.ok(bgTimerFanless);
    bgTimerFanless.cleared = true;
    bgTimerFanless.fn();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(byId.get("frpm")!.textContent, "No fans (passive cooling)");
    assert.equal(byId.get("frow2")!.hidden, true);

    // 4. 3 consecutive background poll failures show disconnected wn banner; recovery shows ✓ Reconnected
    failNextRefresh = true;
    for (let i = 0; i < 3; i += 1) {
      const t = [...timers].reverse().find((x) => !x.cleared && x.ms >= POLL_INTERVAL_FAST_MS);
      assert.ok(t, `expected poll timer on failure #${i + 1}`);
      t.cleared = true;
      t.fn();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    }
    assert.equal(byId.get("bnr")!.hidden, false, "disconnected banner must show after 3 failures");
    assert.equal(byId.get("bnr")!.getAttribute("data-k"), "wn");
    assert.equal(byId.get("hd")!.getAttribute("data-st"), "err", "header dot must reflect disconnected state");
    assert.ok(byId.get("bnr-t")!.textContent.includes("Disconnected"));

    // Turning off auto-refresh updates chip label and stops promising auto-retry in banner
    const autoChip = byId.get("auto-chip")!;
    autoChip.setAttribute("data-a", "auto");
    appRoot.dispatch("click", { target: { closest: () => autoChip } });
    assert.equal(byId.get("auto-lbl")!.textContent, "Manual");
    assert.ok(byId.get("bnr-t")!.textContent.includes("Auto refresh off"));
    appRoot.dispatch("click", { target: { closest: () => autoChip } });

    failNextRefresh = false;
    nextPollPayload = { unchanged: true, hash: "h2b", timestamp: "2026-01-01T00:00:30Z", serverMs: 2 };
    const recTimer = [...timers].reverse().find((x) => !x.cleared && x.ms >= POLL_INTERVAL_FAST_MS);
    assert.ok(recTimer);
    recTimer.cleared = true;
    recTimer.fn();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(byId.get("bnr")!.hidden, true, "banner must clear on recovery");
    assert.equal(byId.get("fb-t")!.textContent, "✓ Reconnected");

    // 5. onhostcontextchanged with containerDimensions triggers immediate fresh refresh
    clock += 1000;
    const prevCount = rpcCalls.length;
    emitWin("message", {
      source: fakeParent,
      data: {
        jsonrpc: "2.0",
        method: "ui/notifications/host-context-changed",
        params: { containerDimensions: { width: 420 } },
      },
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(rpcCalls.length, prevCount + 1);
    assert.equal(rpcCalls[rpcCalls.length - 1].name, "clamshell_refresh");
    assert.equal(rpcCalls[rpcCalls.length - 1].arguments.fresh, true);

    // 6. Lock button in Display footer calls clamshell_lock_screen and updates #fb-t (zero innerHTML)
    const lockBtn = byId.get("lock-btn")!;
    appRoot.dispatch("click", { target: { closest: () => lockBtn } });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(rpcCalls[rpcCalls.length - 1].name, "clamshell_lock_screen");
    assert.equal(byId.get("fb-t")!.textContent, "✓ Locked");

    // 7. flushQueue transient error with concurrent pendingPatch preserves failed fields
    let failFirstCfg: (() => void) | null = null;
    configureHandlers.push((id) => {
      failFirstCfg = () =>
        emitWin("message", {
          source: fakeParent,
          data: {
            jsonrpc: "2.0",
            id,
            result: { isError: true, content: [{ type: "text", text: "transient" }] },
          },
        });
    });
    configureHandlers.push((id, args) => {
      setImmediate(() =>
        emitWin("message", {
          source: fakeParent,
          data: {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: "ok" }],
              structuredContent: {
                ...boot,
                settings: { ...boot.settings, ...args },
                policy: {
                  ...boot.policy,
                  profile: String(args.modeOverride || "normal"),
                  modeSource: "manual",
                  maxJobs: 2,
                },
                guardStatus: args.guardEnabled === false ? "paused" : "armed",
                hash: "h3",
                serverMs: 2,
              },
            },
          },
        })
      );
    });
    const ecoBtn = mkEl("m-eco", { "data-m": "eco" });
    const guardBtn = byId.get("guard-btn")!;
    appRoot.dispatch("click", { target: { closest: () => ecoBtn } });
    appRoot.dispatch("click", { target: { closest: () => guardBtn } });
    assert.ok(failFirstCfg);
    (failFirstCfg as () => void)();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const cfgCalls = rpcCalls.filter((c) => c.name === "clamshell_configure");
    assert.equal(cfgCalls.length, 2);
    assert.deepEqual({ ...cfgCalls[1].arguments }, { modeOverride: "eco", guardEnabled: false });
    assert.equal(byId.get("fb-t")!.textContent, "✓ Saved");

    // 8. Teardown cleanly disconnects observers
    emitWin("message", {
      source: fakeParent,
      data: { jsonrpc: "2.0", id: 999, method: "ui/resource-teardown", params: {} },
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(roDisconnected, true);
    assert.equal(ioDisconnected, true);
  });

  it("recovers handshake on Retry after init failure and gates tool controls on serverTools", async () => {
    const html = fs.readFileSync(path.join(PANEL_DIR, "dist", "panel.html"), "utf8");
    const m = html.match(/<script>([\s\S]+)<\/script>/);
    assert.ok(m);

    const runPanelHarness = async ({
      initResponder,
      bootOverride,
    }: {
      initResponder: (n: number, msg: { id?: unknown }) => unknown;
      bootOverride: PanelSnapshot | null;
    }) => {
      const byId = new Map<string, FakeElement>();
      const mkEl = (id = "", attrs: Record<string, string> = {}): FakeElement => {
        const attrMap = new Map(Object.entries(attrs));
        let textVal = "";
        const listeners = new Map<string, Array<(ev?: unknown) => void>>();
        const el: FakeElement = {
          id,
          disabled: false,
          hidden: false,
          tabIndex: 0,
          className: "",
          title: "",
          style: { setProperty() {}, backgroundColor: "", colorScheme: "", width: "" },
          lastElementChild: null,
          get textContent(): string {
            return textVal;
          },
          set textContent(v: string) {
            textVal = String(v);
          },
          setAttribute(k, v) {
            attrMap.set(k, String(v));
          },
          getAttribute(k) {
            return attrMap.has(k) ? attrMap.get(k)! : null;
          },
          removeAttribute(k) {
            attrMap.delete(k);
          },
          appendChild(c) {
            return c;
          },
          replaceChildren() {},
          addEventListener(t, fn) {
            if (!listeners.has(t)) listeners.set(t, []);
            listeners.get(t)!.push(fn);
          },
          removeEventListener(t, fn) {
            listeners.set(
              t,
              (listeners.get(t) || []).filter((f) => f !== fn)
            );
          },
          dispatch(t, ev) {
            for (const fn of listeners.get(t) || []) fn(ev);
          },
          querySelector: () => null,
          querySelectorAll: () => [],
          getBoundingClientRect: () => ({ width: 380, height: 600, left: 0 }),
        };
        if (id) byId.set(id, el);
        return el;
      };
      const appRoot = mkEl("app");
      for (const id of [
        "shell", "emp", "emp-msg", "emp-btn", "swp", "hd", "hs", "fb", "fb-p", "fb-d", "fb-t", "fb-r",
        "auto-chip", "auto-lbl", "lang-grp", "refresh-btn", "bnr", "bnr-t", "bnr-act", "bnr-x",
        "k0", "h-lid-d", "h-lid", "k1", "h-pwr-d", "h-pwr", "hbb", "hbf", "k2", "h-thm-d", "h-thm", "k3", "h-grd-d", "h-grd",
        "k4", "bt", "bv", "bright-track", "prs-grp", "bc", "k5", "gs", "guard-btn", "lock-btn", "k6",
        "k7", "mb", "mode-rail", "k8", "ar", "jd", "sv", "ji", "fan-card", "k9", "frpm", "fth", "frow2", "ka", "fctrl", "fown", "fcap",
        "diag-tray", "kb", "tp", "kc", "dmu", "dmt", "dmf", "dc", "kd", "dld", "dsp", "ds", "dlm", "ke", "ac-grp", "de", "dh", "dhi", "ht", "ft",
      ]) {
        mkEl(id);
      }
      byId.get("bnr-act")!.setAttribute("data-a", "bnr-retry");
      byId.get("lock-btn")!.setAttribute("data-a", "lock");
      byId.get("guard-btn")!.setAttribute("data-a", "guard");
      byId.get("auto-chip")!.lastElementChild = byId.get("auto-lbl")!;

      const winListeners = new Map<string, Array<(ev?: unknown) => void>>();
      const emitWin = (type: string, ev: unknown): void => {
        for (const fn of winListeners.get(type) || []) fn(ev);
      };
      const calls: string[] = [];
      let initCount = 0;
      const fakeParent = {
        postMessage(msg: { id?: unknown; method?: string; params?: { name: string } }): void {
          if (msg.method === "ui/initialize") {
            initCount += 1;
            const reply = initResponder(initCount, msg);
            setImmediate(() => emitWin("message", { source: fakeParent, data: reply }));
          } else if (msg.method === "tools/call" && msg.params) {
            calls.push(msg.params.name);
            setImmediate(() =>
              emitWin("message", {
                source: fakeParent,
                data: {
                  jsonrpc: "2.0",
                  id: msg.id,
                  result: {
                    content: [{ type: "text", text: "ok" }],
                    structuredContent: {
                      unchanged: true,
                      hash: "h1",
                      timestamp: "2026-01-01T00:00:05Z",
                      serverMs: 1,
                    },
                  },
                },
              })
            );
          }
        },
      };
      const ctx: Record<string, unknown> = {
        window: {
          parent: fakeParent,
          innerWidth: 400,
          __MAC_CLAMSHELL_BOOT__: bootOverride,
          addEventListener(t: string, fn: (ev?: unknown) => void) {
            if (!winListeners.has(t)) winListeners.set(t, []);
            winListeners.get(t)!.push(fn);
          },
          removeEventListener(t: string, fn: (ev?: unknown) => void) {
            winListeners.set(
              t,
              (winListeners.get(t) || []).filter((f) => f !== fn)
            );
          },
        },
        document: {
          documentElement: mkEl("__html"),
          body: mkEl("__body"),
          hidden: false,
          getElementById: (id: string) => byId.get(id) || null,
          querySelector: () => null,
          createElement: (tag: string) => mkEl("", { _tag: tag }),
          createTextNode: (t: unknown) => ({ textContent: String(t) }),
          addEventListener() {},
          removeEventListener() {},
        },
        navigator: { language: "en-US" },
        performance: { now: () => 1000 },
        Date,
        setTimeout: () => 1,
        clearTimeout() {},
        requestAnimationFrame: (fn: () => void) => fn(),
        console,
      };
      ctx.globalThis = ctx;
      vm.runInNewContext(m[1], ctx);
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      return { byId, appRoot, calls, getInitCount: () => initCount };
    };

    const boot: PanelSnapshot = {
      timestamp: "2026-01-01T00:00:00Z",
      locale: "en",
      lidState: "open",
      powerSource: "ac",
      batteryPct: 90,
      thermalState: "ok",
      thermalPressure: "nominal",
      cpuTopology: { total: 8, performanceCores: 4, efficiencyCores: 4 },
      host: {
        hostname: "mbp",
        chip: "Apple M3",
        macosVersion: "15.4",
        uptimeSeconds: 600,
        loadAvg: [1, 1, 1],
        memory: { usedGb: 8, totalGb: 16, compressedGb: 1, usedPct: 50 },
      },
      settings: {
        modeOverride: "auto",
        maxJobsOverride: 0,
        guardEnabled: true,
        acClosedProfile: "utility",
        bgPollIntervalSec: 6,
      },
      policy: { profile: "normal", modeSource: "auto", maxJobs: 8, niceLevel: 0 },
      display: { available: true, percent: 60, savedPercent: 60, asleep: false },
      fan: {
        status: "fanless",
        fans: [],
        smcMode: "none",
        controller: "System (macOS)",
        externalManagers: [],
        ownershipMode: "observer",
        readOnly: true,
      },
      guardStatus: "armed",
      hash: "h1",
    };

    // Part A: Initial handshake fails (bad protocolVersion), Retry re-runs ui/initialize and recovers!
    const retryRun = await runPanelHarness({
      bootOverride: boot,
      initResponder: (n, msg) =>
        n === 1
          ? {
              jsonrpc: "2.0",
              id: msg.id,
              result: { protocolVersion: "2025-01-01", hostCapabilities: { serverTools: {} }, hostContext: { theme: "dark" } },
            }
          : {
              jsonrpc: "2.0",
              id: msg.id,
              result: { protocolVersion: "2026-01-26", hostCapabilities: { serverTools: {} }, hostContext: { theme: "dark" } },
            },
    });
    assert.equal(retryRun.getInitCount(), 1);
    assert.equal(retryRun.byId.get("bnr")!.hidden, false);
    assert.equal(retryRun.byId.get("hd")!.getAttribute("data-st"), "err");
    assert.equal(retryRun.byId.get("lock-btn")!.disabled, true);
    assert.equal(retryRun.calls.length, 0);

    retryRun.appRoot.dispatch("click", { target: { closest: () => retryRun.byId.get("bnr-act") } });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(retryRun.getInitCount(), 2, "Retry must re-run ui/initialize with message listener reattached");
    assert.equal(retryRun.byId.get("bnr")!.hidden, true);
    assert.equal(retryRun.byId.get("lock-btn")!.disabled, false);
    assert.deepEqual(retryRun.calls, ["clamshell_refresh"]);

    // Part B: Host omits serverTools -> keep boot display data, disable tool controls, send zero tools/call
    const roRun = await runPanelHarness({
      bootOverride: boot,
      initResponder: (_n, msg) => ({
        jsonrpc: "2.0",
        id: msg.id,
        result: { protocolVersion: "2026-01-26", hostCapabilities: {}, hostContext: { theme: "dark" } },
      }),
    });
    assert.equal(roRun.byId.get("h-lid")!.textContent, "Open");
    assert.equal(roRun.byId.get("bv")!.textContent, "60%");
    assert.equal(roRun.byId.get("lock-btn")!.disabled, true);
    assert.equal(roRun.byId.get("guard-btn")!.disabled, true);
    assert.equal(roRun.byId.get("refresh-btn")!.disabled, true);
    assert.equal(roRun.byId.get("bright-track")!.getAttribute("aria-disabled"), "true");
    assert.equal(roRun.calls.length, 0);

    // Part C: Blank-boot (boot: null) handshake failure surfaces Retry in #emp and recovers on click
    const blankRetry = await runPanelHarness({
      bootOverride: null,
      initResponder: (n, msg) =>
        n === 1
          ? { jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "Parent unavailable" } }
          : {
              jsonrpc: "2.0",
              id: msg.id,
              result: { protocolVersion: "2026-01-26", hostCapabilities: { serverTools: {} }, hostContext: { theme: "dark" } },
            },
    });
    assert.equal(blankRetry.byId.get("emp")!.hidden, false);
    assert.equal(blankRetry.byId.get("emp-btn")!.hidden, false);
    assert.equal(blankRetry.byId.get("emp-btn")!.textContent, "Retry");
    blankRetry.byId.get("emp-btn")!.setAttribute("data-a", "refresh");
    blankRetry.appRoot.dispatch("click", { target: { closest: () => blankRetry.byId.get("emp-btn") } });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(blankRetry.getInitCount(), 2);
    assert.deepEqual(blankRetry.calls, ["clamshell_refresh"]);
  });

  it("resolves bilingual panel language, guard status, optimistic state, and all 4 read-only fan states", () => {
    assert.equal(resolvePanelLang({ saved: "zh-CN", hostLocale: "en-US" }), "zh-CN");
    assert.equal(resolvePanelLang({ saved: null, hostLocale: "zh-Hans-CN", navLang: "en" }), "zh-CN");
    assert.equal(resolvePanelLang({ saved: null, hostLocale: "fr-FR", navLang: "en-US" }), "en");
    // P0: boot.locale (from settings.json) takes precedence over navigator.language when localStorage is unavailable
    assert.equal(
      resolvePanelLang({ saved: null, settingsLang: null, hostLocale: null, bootLocale: "zh-CN", navLang: "en-US" }),
      "zh-CN"
    );

    assert.equal(describeGuardStatus({ settings: { guardEnabled: false } }, 80, "en"), "Guard paused");
    assert.equal(
      describeGuardStatus({ guardStatus: "protecting", settings: { guardEnabled: true } }, 65, "zh-CN"),
      "保持熄屏 · 唤醒后 65%"
    );

    // Fan states: fanless, active dual RPM, Macs Fan Control yield, unavailable
    const fanless = describeFanState({ status: "fanless", fans: [], ownershipMode: "observer", readOnly: true }, "en", true);
    assert.equal(fanless.rpmText, "No fans (passive cooling)");
    assert.equal(fanless.showController, false);
    assert.ok(fanless.caption.includes("guard paused"));

    const dual = describeFanState(
      {
        status: "ok",
        fans: [
          { id: 0, rpm: 2140, manual: false },
          { id: 1, rpm: 2210, manual: false },
        ],
        smcMode: "auto",
        controller: "System (macOS)",
        externalManagers: [],
        detectedMonitors: ["Fanny"],
        ownershipMode: "observer",
        readOnly: true,
      },
      "en"
    );
    assert.equal(dual.rpmText, "L 2,140 · R 2,210 rpm");
    assert.equal(dual.controller, "macOS (auto)");
    assert.equal(dual.badgeText, "Read-only");
    assert.equal(dual.badgeKind, "in");
    assert.equal(dual.showController, true);
    assert.ok(dual.caption.includes("Fanny"));

    const yieldMfc = describeFanState(
      {
        status: "ok",
        fans: [
          { id: 0, rpm: 4200, manual: true },
          { id: 1, rpm: 4300, manual: true },
        ],
        smcMode: "manual",
        controller: "Macs Fan Control",
        externalManagers: ["Macs Fan Control"],
        ownershipMode: "yield",
        readOnly: true,
      },
      "zh-CN"
    );
    assert.equal(yieldMfc.rpmText, "左 4,200 · 右 4,300 rpm");
    assert.equal(yieldMfc.controller, "Macs Fan Control");
    assert.equal(yieldMfc.badgeText, "外部控制");
    assert.equal(yieldMfc.badgeKind, "wn");
    assert.equal(yieldMfc.caption, "只读 · 手动 · Macs Fan Control");

    const unavail = describeFanState(
      {
        status: "unavailable",
        fans: [],
        smcMode: "unknown",
        controller: "Unknown",
        externalManagers: [],
        ownershipMode: "observer",
        readOnly: true,
      },
      "en",
      true
    );
    assert.equal(unavail.rpmText, "Can't read fan speed");
    assert.equal(unavail.controller, "Unknown");
    assert.equal(unavail.badgeKind, "in");
    assert.equal(unavail.showController, true);
    assert.ok(unavail.caption.includes("guard paused"));

    const base: PanelSnapshot = {
      lidState: "open",
      powerSource: "ac",
      thermalState: "ok",
      cpuTopology: { total: 10, performanceCores: 6, efficiencyCores: 4 },
      policy: { profile: "normal", autoProfile: "normal", maxJobs: 10 },
      profileJobs: { normal: 10, utility: 4, eco: 2, strict: 1, autoEco: 1 },
      guardStatus: "armed",
      settings: {
        modeOverride: "auto",
        maxJobsOverride: 0,
        guardEnabled: true,
        acClosedProfile: "utility",
        bgPollIntervalSec: 6,
      },
      envVars: { CARGO_BUILD_JOBS: "4" },
    };
    const paused = computeOptimisticState(base, { guardEnabled: false, modeOverride: "eco", maxJobsOverride: 3 });
    assert.equal(paused.guardStatus, "paused");
    assert.equal(paused.policy!.profile, "eco");
    assert.equal(paused.policy!.modeSource, "manual");
    assert.equal(paused.policy!.maxJobs, 3);

    const closedAc = computeOptimisticState(
      { ...base, lidState: "closed", policy: { profile: "utility", autoProfile: "utility", maxJobs: 4 } },
      { acClosedProfile: "eco" }
    );
    assert.equal(closedAc.policy!.autoProfile, "eco");
    assert.equal(closedAc.policy!.profile, "eco");
    assert.equal(closedAc.policy!.maxJobs, 1);
  });

  it("bridge rejects top-level self-parent, scopes progress resets with maxTimeoutMs, enforces connEpoch & serverTools", async () => {
    // 1. Reject window.parent === window (top-level self-messages)
    const selfWin: BridgeWindow & { postMessage(): never } = {
      addEventListener() {},
      removeEventListener() {},
      postMessage() {
        throw new Error("should never post to self");
      },
    };
    selfWin.parent = selfWin;
    const topLevelApp = App({ name: "Test", version: "1.4.0" }, {}, { window: selfWin, document: null });
    await assert.rejects(() => topLevelApp.connect(), /parent/i);

    // 2. Handshake retry + connEpoch fencing + bridge-level hasServerTools() check + progressToken scoping
    const listeners = new Map<string, Array<(ev: BridgeMessageEvent) => void>>();
    const mkWin = (parent: BridgeTargetWindow): BridgeWindow => ({
      parent,
      addEventListener(t, fn) {
        if (!listeners.has(t)) listeners.set(t, []);
        listeners.get(t)!.push(fn);
      },
      removeEventListener(t, fn) {
        listeners.set(
          t,
          (listeners.get(t) || []).filter((f) => f !== fn)
        );
      },
    });
    const emit = (ev: BridgeMessageEvent): void => {
      for (const fn of listeners.get("message") || []) fn(ev);
    };

    let initAttempt = 0;
    const parent: BridgeTargetWindow = {
      postMessage(rawMsg) {
        const msg = rawMsg as { id?: unknown; method?: string };
        if (msg.method === "ui/initialize") {
          initAttempt += 1;
          const reply =
            initAttempt === 1
              ? { jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "transient" } }
              : {
                  jsonrpc: "2.0",
                  id: msg.id,
                  result: {
                    protocolVersion: "2026-01-26",
                    hostCapabilities: {},
                    hostContext: { theme: "dark" },
                  },
                };
          setImmediate(() => emit({ source: parent, data: reply }));
        }
      },
    };
    const appNoTools = App(
      { name: "Test", version: "1.4.0" },
      {},
      { window: mkWin(parent), document: null }
    );
    await appNoTools.connect({ retries: 1, retryDelayMs: 5 });
    assert.equal(initAttempt, 2);
    assert.equal(appNoTools.hasServerTools(), false);
    await assert.rejects(
      () => appNoTools.callServerTool({ name: "clamshell_refresh", arguments: {} }),
      /serverTools/i
    );
    appNoTools.close();

    // 3. connEpoch fencing: closing mid-connect rejects with Closed and ignores late reply
    let lateInitId: unknown = null;
    const slowParent: BridgeTargetWindow = {
      postMessage(rawMsg) {
        const msg = rawMsg as { id?: unknown; method?: string };
        if (msg.method === "ui/initialize") lateInitId = msg.id;
      },
    };
    const fenced = App(
      { name: "Test", version: "1.4.0" },
      {},
      { window: mkWin(slowParent), document: null }
    );
    const pendingConn = fenced.connect({ retries: 0, timeoutMs: 5_000 });
    fenced.close();
    await assert.rejects(() => pendingConn, /Closed/);
    emit({
      source: slowParent,
      data: {
        jsonrpc: "2.0",
        id: lateInitId,
        result: { protocolVersion: "2026-01-26", hostCapabilities: { serverTools: {} }, hostContext: {} },
      },
    });
    assert.equal(fenced.isConnected(), false);

    // 4. progressToken scoping + maxTimeoutMs hard cap
    const progParent: BridgeTargetWindow = {
      postMessage(rawMsg) {
        const msg = rawMsg as { id?: unknown; method?: string };
        if (msg.method === "ui/initialize") {
          setImmediate(() =>
            emit({
              source: progParent,
              data: {
                jsonrpc: "2.0",
                id: msg.id,
                result: { protocolVersion: "2026-01-26", hostCapabilities: { serverTools: {} }, hostContext: {} },
              },
            })
          );
        }
      },
    };
    const progApp = App(
      { name: "Test", version: "1.4.0" },
      {},
      { window: mkWin(progParent), document: null }
    );
    await progApp.connect();
    const p1 = progApp.request("tools/call", { _meta: { progressToken: "tok-a" } }, { timeoutMs: 40, maxTimeoutMs: 75 });
    const p2 = progApp.request("tools/call", { _meta: { progressToken: "tok-b" } }, { timeoutMs: 30, maxTimeoutMs: 120 });
    // Send progress only for tok-a: tok-b must still expire near 30ms, and tok-a must still hit maxTimeoutMs cap!
    const interval = setInterval(() => {
      emit({
        source: progParent,
        data: { jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "tok-a", progress: 1 } },
      });
    }, 15);
    try {
      await assert.rejects(() => p2, /Timeout/);
      await assert.rejects(() => p1, /Timeout/);
    } finally {
      clearInterval(interval);
      progApp.close();
    }
  });

  it("supports weak-net RTT scaling, 0ms localStorage SWR hydration, fresh-boot coalescing, document.hidden pause, and pollSeq out-of-order drop", async () => {
    assert.equal(computeAdaptiveIntervalMs({ rttMs: 2000, fgOverrideMs: 3000 }), 6000);
    assert.equal(computeAdaptiveIntervalMs({ rttMs: 6000, fgOverrideMs: 3000 }), 15_000);

    const html = fs.readFileSync(path.join(PANEL_DIR, "dist", "panel.html"), "utf8");
    const m = html.match(/<script>([\s\S]+)<\/script>/);
    assert.ok(m);

    const baseBoot: PanelSnapshot = {
      timestamp: "2026-01-01T00:00:00Z",
      locale: "en",
      lidState: "open",
      powerSource: "ac",
      batteryPct: 90,
      thermalState: "ok",
      thermalPressure: "nominal",
      cpuTopology: { total: 8, performanceCores: 4, efficiencyCores: 4 },
      host: {
        hostname: "mbp",
        chip: "Apple M3",
        macosVersion: "15.4",
        uptimeSeconds: 600,
        loadAvg: [1, 1, 1],
        memory: { usedGb: 8, totalGb: 16, compressedGb: 1, usedPct: 50 },
      },
      settings: { modeOverride: "auto", maxJobsOverride: 0, guardEnabled: true, acClosedProfile: "utility" },
      policy: { profile: "normal", autoProfile: "normal", modeSource: "auto", maxJobs: 8, niceLevel: 0 },
      display: { available: true, percent: 60, savedPercent: 60, asleep: false },
      fan: { status: "fanless", fans: [], smcMode: "none", controller: "System (macOS)", ownershipMode: "observer", readOnly: true },
      guardStatus: "armed",
      hash: "h-boot",
    };

    const runWeakNetHarness = async ({
      bootOverride,
      initialStorage,
      clockStart = 50_000,
    }: {
      bootOverride: PanelSnapshot | null;
      initialStorage?: Record<string, string>;
      clockStart?: number;
    }) => {
      const byId = new Map<string, FakeElement>();
      const mkEl = (id = "", attrs: Record<string, string> = {}): FakeElement => {
        const attrMap = new Map(Object.entries(attrs));
        let textVal = "";
        const listeners = new Map<string, Array<(ev?: unknown) => void>>();
        const el: FakeElement = {
          id,
          disabled: false,
          hidden: false,
          tabIndex: 0,
          className: "",
          title: "",
          style: { setProperty() {}, backgroundColor: "", colorScheme: "", width: "" },
          lastElementChild: null,
          get textContent(): string {
            return textVal;
          },
          set textContent(v: string) {
            textVal = String(v);
          },
          setAttribute(k, v) {
            attrMap.set(k, String(v));
          },
          getAttribute(k) {
            return attrMap.has(k) ? attrMap.get(k)! : null;
          },
          removeAttribute(k) {
            attrMap.delete(k);
          },
          appendChild(c) {
            return c;
          },
          replaceChildren() {},
          addEventListener(t, fn) {
            if (!listeners.has(t)) listeners.set(t, []);
            listeners.get(t)!.push(fn);
          },
          removeEventListener(t, fn) {
            listeners.set(t, (listeners.get(t) || []).filter((f) => f !== fn));
          },
          dispatch(t, ev) {
            for (const fn of listeners.get(t) || []) fn(ev);
          },
          querySelector: () => null,
          querySelectorAll: () => [],
          getBoundingClientRect: () => ({ width: 380, height: 600, left: 0 }),
        };
        if (id) byId.set(id, el);
        return el;
      };
      const appRoot = mkEl("app");
      for (const id of [
        "shell", "emp", "emp-msg", "emp-btn", "swp", "hd", "hs", "fb", "fb-p", "fb-d", "fb-t", "fb-r",
        "auto-chip", "auto-lbl", "lang-grp", "refresh-btn", "bnr", "bnr-t", "bnr-act", "bnr-x",
        "k0", "h-lid-d", "h-lid", "k1", "h-pwr-d", "h-pwr", "hbb", "hbf", "k2", "h-thm-d", "h-thm", "k3", "h-grd-d", "h-grd",
        "k4", "bt", "bv", "bright-track", "prs-grp", "bc", "k5", "gs", "guard-btn", "lock-btn", "k6",
        "k7", "mb", "mode-rail", "k8", "ar", "jd", "sv", "ji", "fan-card", "k9", "frpm", "fth", "frow2", "ka", "fctrl", "fown", "fcap",
        "diag-tray", "kb", "tp", "kc", "dmu", "dmt", "dmf", "dc", "kd", "dld", "dsp", "ds", "dlm", "ke", "ac-grp", "de", "dh", "dhi", "ht", "ft",
      ]) {
        mkEl(id);
      }
      byId.get("guard-btn")!.setAttribute("data-a", "guard");
      byId.get("auto-chip")!.lastElementChild = byId.get("auto-lbl")!;

      const storageMap = new Map<string, string>(Object.entries(initialStorage || {}));
      const localStorageMock = {
        getItem: (k: string) => (storageMap.has(k) ? storageMap.get(k)! : null),
        setItem: (k: string, v: string) => void storageMap.set(k, String(v)),
        removeItem: (k: string) => void storageMap.delete(k),
      };

      let docHidden = false;
      const docListeners = new Map<string, Array<(ev?: unknown) => void>>();
      const winListeners = new Map<string, Array<(ev?: unknown) => void>>();
      const emitWin = (type: string, ev: unknown): void => {
        for (const fn of winListeners.get(type) || []) fn(ev);
      };
      const timers: Array<{ id: number; fn: () => void; ms: number; cleared: boolean }> = [];
      let tid = 1;
      const rpcCalls: Array<{ id: unknown; name: string; arguments: Record<string, unknown> }> = [];
      const pendingCalls: Array<(payload: Record<string, unknown>) => void> = [];
      let holdRpc = false;

      const fakeParent = {
        postMessage(msg: { id?: unknown; method?: string; params?: { name: string; arguments: Record<string, unknown> } }): void {
          if (msg.method === "ui/initialize") {
            setImmediate(() =>
              emitWin("message", {
                source: fakeParent,
                data: {
                  jsonrpc: "2.0",
                  id: msg.id,
                  result: {
                    protocolVersion: "2026-01-26",
                    hostCapabilities: { serverTools: {} },
                    hostContext: { theme: "dark" },
                  },
                },
              })
            );
          } else if (msg.method === "tools/call" && msg.params) {
            rpcCalls.push({ id: msg.id, ...msg.params });
            const respond = (sc: Record<string, unknown>) =>
              emitWin("message", {
                source: fakeParent,
                data: {
                  jsonrpc: "2.0",
                  id: msg.id,
                  result: { content: [{ type: "text", text: "ok" }], structuredContent: sc },
                },
              });
            if (holdRpc) {
              pendingCalls.push(respond);
            } else {
              setImmediate(() =>
                respond({
                  unchanged: true,
                  hash: bootOverride?.hash || "h-boot",
                  timestamp: "2026-01-01T00:00:05Z",
                  serverMs: 1,
                })
              );
            }
          }
        },
      };

      let clock = clockStart;
      class FakeDate extends Date {
        static override now(): number {
          return clock;
        }
      }

      const ctx: Record<string, unknown> = {
        window: {
          parent: fakeParent,
          innerWidth: 400,
          __MAC_CLAMSHELL_BOOT__: bootOverride,
          addEventListener(t: string, fn: (ev?: unknown) => void) {
            if (!winListeners.has(t)) winListeners.set(t, []);
            winListeners.get(t)!.push(fn);
          },
          removeEventListener(t: string, fn: (ev?: unknown) => void) {
            winListeners.set(t, (winListeners.get(t) || []).filter((f) => f !== fn));
          },
        },
        document: {
          documentElement: mkEl("__html"),
          body: mkEl("__body"),
          get hidden(): boolean {
            return docHidden;
          },
          getElementById: (id: string) => byId.get(id) || null,
          querySelector: () => null,
          createElement: (tag: string) => mkEl("", { _tag: tag }),
          createTextNode: (t: unknown) => ({ textContent: String(t) }),
          addEventListener(t: string, fn: (ev?: unknown) => void) {
            if (!docListeners.has(t)) docListeners.set(t, []);
            docListeners.get(t)!.push(fn);
          },
          removeEventListener(t: string, fn: (ev?: unknown) => void) {
            docListeners.set(t, (docListeners.get(t) || []).filter((f) => f !== fn));
          },
        },
        localStorage: localStorageMock,
        navigator: { language: "en-US" },
        performance: { now: () => clock },
        Date: FakeDate,
        setTimeout: (fn: () => void, ms: number) => {
          const id = tid++;
          timers.push({ id, fn, ms, cleared: false });
          return id;
        },
        clearTimeout: (id: number) => {
          const t = timers.find((x) => x.id === id);
          if (t) t.cleared = true;
        },
        requestAnimationFrame: (fn: () => void) => fn(),
        console,
      };
      ctx.globalThis = ctx;
      vm.runInNewContext(m[1], ctx);

      return {
        byId,
        appRoot,
        mkEl,
        timers,
        rpcCalls,
        pendingCalls,
        storageMap,
        setHoldRpc: (v: boolean) => {
          holdRpc = v;
        },
        setHidden: (v: boolean) => {
          docHidden = v;
          for (const fn of docListeners.get("visibilitychange") || []) fn();
        },
        advanceClock: (ms: number) => {
          clock += ms;
        },
      };
    };

    // A. Instant 0ms localStorage hydration when boot === null (no "Loading..." flash before connect())
    const cachedClosed: PanelSnapshot = {
      ...baseBoot,
      lidState: "closed",
      guardStatus: "protecting",
      hash: "h-cached",
    };
    const cacheRun = await runWeakNetHarness({
      bootOverride: null,
      initialStorage: {
        "mac-clamshell-snap": JSON.stringify({ v: 1, savedAt: 49_000, data: cachedClosed }),
      },
    });
    // Synchronously at Frame 0 before connect() finishes:
    assert.equal(cacheRun.byId.get("emp")!.hidden, true, "must not flash empty/loading screen when localStorage has snapshot");
    assert.equal(cacheRun.byId.get("h-lid")!.textContent, "Closed");
    assert.equal(cacheRun.byId.get("bv")!.textContent, "60%");
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(cacheRun.rpcCalls.length, 1, "hydrated localStorage boot must trigger background SWR refresh after connect");
    assert.equal(cacheRun.rpcCalls[0].name, "clamshell_refresh");

    // A2. Newer localStorage overrides older boot (savedAt > boot.bootTs)
    const newerCacheRun = await runWeakNetHarness({
      bootOverride: { ...baseBoot, bootTs: 40_000, lidState: "open", hash: "h-old-boot" },
      initialStorage: {
        "mac-clamshell-snap": JSON.stringify({ v: 1, savedAt: 49_000, data: cachedClosed }),
      },
    });
    assert.equal(newerCacheRun.byId.get("h-lid")!.textContent, "Closed", "newer localStorage must override older boot");
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(newerCacheRun.rpcCalls.length, 1);

    // B. Fresh-boot coalescing (bootTs < 2500ms, stale: false) + document.hidden pause + out-of-order pollSeq drop
    const freshBoot: PanelSnapshot = { ...baseBoot, bootTs: 49_500, stale: false };
    const freshRun = await runWeakNetHarness({
      bootOverride: freshBoot,
      clockStart: 50_000,
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(freshRun.rpcCalls.length, 0, "fresh SSR boot (<2500ms) must coalesce duplicate t=0 refresh");
    const activePollTimers = freshRun.timers.filter((t) => !t.cleared && t.ms >= POLL_INTERVAL_FAST_MS);
    assert.equal(activePollTimers.length, 1, "markInitialBoot must schedule first poll at currentIntervalMs");

    // document.hidden pauses polling immediately with default bgPollIntervalSec=0
    freshRun.setHidden(true);
    const remainingPollTimers = freshRun.timers.filter((t) => !t.cleared && t.ms >= POLL_INTERVAL_FAST_MS);
    assert.equal(remainingPollTimers.length, 0, "document.hidden must cancel active poll timer when bgPollIntervalSec <= 0");
    assert.equal(freshRun.byId.get("ft")!.textContent, "Paused");

    // Returning to visible triggers visibility refresh; simulate out-of-order stale poll reply dropped after configure
    freshRun.setHoldRpc(true);
    freshRun.advanceClock(1000);
    freshRun.setHidden(false);
    assert.equal(freshRun.rpcCalls.length, 1);
    assert.equal(freshRun.rpcCalls[0].name, "clamshell_refresh");

    const ecoBtn = freshRun.mkEl("m-eco", { "data-m": "eco" });
    freshRun.appRoot.dispatch("click", { target: { closest: () => ecoBtn } });
    assert.equal(freshRun.rpcCalls.length, 2);
    assert.equal(freshRun.rpcCalls[1].name, "clamshell_configure");

    // Resolve newer configure (seq 2) BEFORE older refresh (seq 1)
    freshRun.pendingCalls[1]({
      ...freshBoot,
      settings: { ...freshBoot.settings, modeOverride: "eco" },
      policy: { ...freshBoot.policy, profile: "eco", modeSource: "manual", maxJobs: 2 },
      hash: "h-eco",
      serverMs: 2,
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(freshRun.byId.get("mb")!.textContent, "Manual");

    // Now stale refresh resolves with old profile "normal" / hash "h-boot" — MUST be dropped!
    freshRun.pendingCalls[0]({
      ...freshBoot,
      lidState: "closed",
      settings: { ...freshBoot.settings, modeOverride: "auto" },
      policy: { ...freshBoot.policy, profile: "normal", modeSource: "auto", maxJobs: 8 },
      hash: "h-boot",
      serverMs: 5,
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(freshRun.byId.get("h-lid")!.textContent, "Open", "stale out-of-order poll reply must be dropped");
    assert.equal(freshRun.byId.get("mb")!.textContent, "Manual");
  });
});
