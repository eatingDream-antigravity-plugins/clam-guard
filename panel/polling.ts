// Strict single-flight RTT-adaptive polling (foreground + background) & reveal refresh.
export const POLL_INTERVAL_FAST_MS = 3e3;
export const POLL_INTERVAL_MED_MS = 5e3;
export const POLL_INTERVAL_SLOW_MS = 1e4;
export const POLL_INTERVAL_ULTRA_SLOW_MS = 2e4;
export const BG_POLL_INTERVAL_FAST_MS = 6e3;
export const BG_POLL_INTERVAL_MED_MS = 1e4;
export const BG_POLL_INTERVAL_SLOW_MS = 18e3;
export const BG_POLL_INTERVAL_ULTRA_SLOW_MS = 3e4;
export const POLL_INTERVAL_MAX_BACKOFF_MS = 12e4;
export const RTT_MED_THRESHOLD_MS = 150;
export const RTT_HIGH_THRESHOLD_MS = 350;
export const RTT_VERY_HIGH_THRESHOLD_MS = 800;
export const REVEAL_THROTTLE_MS = 250;
export const POINTER_STALE_MS = 900;

const NOOP = (): void => {};
const RN = (): Promise<null> => Promise.resolve(null);
const M = Math;

export interface AdaptiveIntervalOptions {
  rttMs?: number;
  consecutiveErrors?: number;
  hidden?: boolean;
  fgOverrideMs?: number;
  bgOverrideMs?: number;
}

export function computeAdaptiveIntervalMs({
  rttMs = 0,
  consecutiveErrors = 0,
  hidden = false,
  fgOverrideMs = 0,
  bgOverrideMs = 0,
}: AdaptiveIntervalOptions = {}): number {
  const r = +rttMs > 0 ? +rttMs : 0;
  const ov = hidden ? bgOverrideMs : fgOverrideMs;
  const tier = (hidden ? [6e3, 1e4, 18e3, 3e4] : [3e3, 5e3, 1e4, 2e4])[
    r > 800 ? 3 : r > 350 ? 2 : r > 150 ? 1 : 0
  ];
  const b = M.max(ov > 0 ? ov : tier, M.min(15e3, M.round(r * 3)));
  const e = M.max(0, M.floor(+consecutiveErrors || 0));
  return e ? M.min(12e4, b * (1 << M.min(e, 4))) : b;
}

export interface PollerFetchResult {
  unchanged?: boolean;
  serverMs?: number;
}

export interface PollerMetrics {
  enabled: boolean;
  inFlight: boolean;
  inBackground: boolean;
  pausedHidden: boolean;
  lastTotalMs: number | null;
  lastServerMs: number | null;
  lastNetRttMs: number | null;
  ewmaRttMs: number | null;
  consecutiveErrors: number;
  currentIntervalMs: number;
  lastSuccessTs: number;
  unchangedHits: number;
}

export interface AdaptivePollerOptions<
  TRes extends PollerFetchResult = PollerFetchResult,
  TTimer = ReturnType<typeof setTimeout>,
> {
  fetcher: (opts: { force: boolean; reason: string }) => Promise<TRes | null>;
  defaultEnabled?: boolean;
  pauseWhenHidden?: boolean;
  isHidden?: () => boolean;
  shouldSkipBackgroundPoll?: () => boolean;
  onMetrics?: (metrics: PollerMetrics) => void;
  now?: () => number;
  perfNow?: () => number;
  setTimer?: (fn: () => void, ms: number) => TTimer;
  clearTimer?: (id: TTimer) => void;
  revealThrottleMs?: number;
}

export interface AdaptivePoller<TRes extends PollerFetchResult = PollerFetchResult> {
  trigger(opts?: { force?: boolean; reason?: string }): Promise<TRes | null>;
  forceNow(reason?: string): Promise<TRes | null>;
  getMetrics(): PollerMetrics;
  isStale(maxAgeMs?: number): boolean;
  setEnabled(next: boolean): boolean;
  setIntervals(opts?: { fgSec?: number; bgSec?: number }): void;
  handleVisibilityChange(overrideHidden?: boolean): Promise<TRes | null> | void;
  recordExternalRpc(opts?: { totalMs?: number; serverMs?: number; markSuccess?: boolean }): void;
  markInitialBoot(ts?: number): void;
  destroy(): void;
}

export function createAdaptivePoller<
  TRes extends PollerFetchResult = PollerFetchResult,
  TTimer = ReturnType<typeof setTimeout>,
>({
  fetcher,
  defaultEnabled = true,
  pauseWhenHidden = false,
  isHidden = () => typeof document < "u" && Boolean(document.hidden),
  shouldSkipBackgroundPoll = () => false,
  onMetrics = NOOP,
  now = () => Date.now(),
  perfNow = () => (typeof performance < "u" ? performance.now() : Date.now()),
  setTimer = (f, m) => setTimeout(f, m) as unknown as TTimer,
  clearTimer = (i) => clearTimeout(i as unknown as ReturnType<typeof setTimeout>),
  revealThrottleMs = 250,
}: AdaptivePollerOptions<TRes, TTimer>): AdaptivePoller<TRes> {
  let en = !!defaultEnabled;
  let dead = false;
  let inF: Promise<TRes | null> | null = null;
  let qd = false;
  let tid: TTimer | null = null;
  let lt: number | null = null;
  let ls: number | null = null;
  let ln: number | null = null;
  let ew: number | null = null;
  let err = 0;
  let fgO = 0;
  let bgO = 0;
  let bgP = !!pauseWhenHidden;
  let bg = !!isHidden();
  let ms = computeAdaptiveIntervalMs({ hidden: bg });
  let okT = 0;
  let frT = -Infinity;
  let uh = 0;

  const bp = (): boolean => bg && bgP;
  const getMetrics = (): PollerMetrics => ({
    enabled: en,
    inFlight: !!inF,
    inBackground: bg,
    pausedHidden: bp(),
    lastTotalMs: lt,
    lastServerMs: ls,
    lastNetRttMs: ln,
    ewmaRttMs: ew,
    consecutiveErrors: err,
    currentIntervalMs: ms,
    lastSuccessTs: okT,
    unchangedHits: uh,
  });
  const emit = (): void => onMetrics(getMetrics());
  const cancel = (): void => {
    if (tid !== null) {
      clearTimer(tid);
      tid = null;
    }
  };
  const rec = (ov?: boolean): void => {
    bg = ov !== undefined ? !!ov : !!isHidden();
    ms = computeAdaptiveIntervalMs({
      rttMs: ew ?? 0,
      consecutiveErrors: err,
      hidden: bg,
      fgOverrideMs: fgO,
      bgOverrideMs: bgO,
    });
  };
  const smp = (t: number, s = 0): void => {
    lt = M.max(0, M.round(+t || 0));
    ls = M.max(0, M.round(+s || 0));
    ln = M.max(0, lt - ls);
    ew = ew === null ? ln : M.round(ew * 0.65 + ln * 0.35);
    rec();
  };
  const sched = (): void => {
    cancel();
    if (dead || !en) return;
    rec();
    if (bp()) return;
    tid = setTimer(() => {
      tid = null;
      if (dead || !en || bp()) return emit();
      if (shouldSkipBackgroundPoll()) return sched();
      void trigger({ force: false, reason: "poll" }).catch(NOOP);
    }, ms);
  };

  function trigger({ force = false, reason = "manual" }: { force?: boolean; reason?: string } = {}): Promise<TRes | null> {
    if (dead) return RN();
    if (reason === "poll" && (!en || bp())) {
      emit();
      return RN();
    }
    if (inF) {
      if (force) qd = true;
      return inF;
    }
    cancel();
    const t0 = perfNow();
    inF = (async (): Promise<TRes | null> => {
      try {
        const r = await fetcher({ force: !!force, reason });
        err = 0;
        okT = now();
        if (r?.unchanged) uh += 1;
        smp(perfNow() - t0, r?.serverMs);
        return r;
      } catch (e) {
        err += 1;
        rec();
        throw e;
      } finally {
        inF = null;
        rec();
        emit();
        if (!dead) {
          if (qd) {
            qd = false;
            void trigger({ force: true, reason: "queued" }).catch(NOOP);
          } else if (en) {
            sched();
          }
        }
      }
    })();
    emit();
    return inF;
  }

  const forceNow = (reason = "reveal"): Promise<TRes | null> => {
    if (dead) return RN();
    const t = now();
    if (t - frT < revealThrottleMs) return inF || RN();
    frT = t;
    return trigger({ force: true, reason });
  };

  return {
    trigger,
    forceNow,
    getMetrics,
    isStale: (a = 900): boolean => !okT || now() - okT > a,
    setEnabled(n: boolean): boolean {
      en = !!n;
      cancel();
      rec();
      if (en && !inF) sched();
      emit();
      return en;
    },
    setIntervals({ fgSec = 0, bgSec = 0 }: { fgSec?: number; bgSec?: number } = {}): void {
      const f = +fgSec > 0 ? M.round(+fgSec * 1e3) : 0;
      const p = +bgSec < 0 || (!!pauseWhenHidden && +bgSec <= 0);
      const b = !p && +bgSec > 0 ? M.round(+bgSec * 1e3) : 0;
      if (f === fgO && b === bgO && p === bgP) return;
      fgO = f;
      bgO = b;
      bgP = p;
      cancel();
      rec();
      if (en && !inF) sched();
      emit();
    },
    handleVisibilityChange(ov?: boolean): Promise<TRes | null> | void {
      if (dead) return;
      const w = bg;
      rec(ov);
      if (!bg && w) return forceNow("visibility").catch(() => null);
      if (en && !inF) sched();
      emit();
    },
    recordExternalRpc({ totalMs = 0, serverMs = 0, markSuccess = true }: { totalMs?: number; serverMs?: number; markSuccess?: boolean } = {}): void {
      if (dead) return;
      if (markSuccess) {
        err = 0;
        okT = now();
      }
      smp(totalMs, serverMs);
      emit();
    },
    markInitialBoot(ts = now()): void {
      if (!okT) okT = ts;
      rec();
      if (en && !inF && tid === null) sched();
      emit();
    },
    destroy(): void {
      dead = true;
      en = qd = false;
      cancel();
    },
  };
}

export interface RevealEventTargetLike {
  addEventListener?(type: string, listener: () => void, options?: boolean | AddEventListenerOptions): void;
  removeEventListener?(type: string, listener: () => void): void;
}

export interface RevealDocLike extends RevealEventTargetLike {
  hidden?: boolean;
  documentElement?: RevealElementLike | null;
}

export interface RevealElementLike extends RevealEventTargetLike {
  getBoundingClientRect?(): { width: number; height: number };
}

export interface RevealResizeObserverLike {
  observe(target: RevealElementLike): void;
  disconnect(): void;
}

export type RevealResizeObserverCtor = new (
  callback: (entries: ReadonlyArray<{ contentRect?: { width: number; height: number } }>) => void
) => RevealResizeObserverLike;

export interface RevealIntersectionObserverLike {
  observe(target: RevealElementLike): void;
  disconnect(): void;
}

export type RevealIntersectionObserverCtor = new (
  callback: (entries: ReadonlyArray<{ isIntersecting?: boolean }>) => void,
  options?: { threshold?: number }
) => RevealIntersectionObserverLike;

export interface AttachRevealRefreshOptions {
  doc?: RevealDocLike | null;
  win?: RevealEventTargetLike | null;
  target?: RevealElementLike | null;
  poller?: {
    forceNow(reason?: string): Promise<unknown>;
    handleVisibilityChange(overrideHidden?: boolean): unknown;
    isStale(maxAgeMs?: number): boolean;
  } | null;
  onReveal?: (reason: string) => unknown;
  ResizeObserverCtor?: RevealResizeObserverCtor | null;
  IntersectionObserverCtor?: RevealIntersectionObserverCtor | null;
  stalePointerMs?: number;
}

export function attachRevealRefresh({
  doc = typeof document < "u" ? document : null,
  win = typeof window < "u" ? window : null,
  target = doc?.documentElement || null,
  poller,
  onReveal = (r) => poller?.forceNow?.(r)?.catch?.(NOOP),
  ResizeObserverCtor = typeof ResizeObserver < "u"
    ? (ResizeObserver as unknown as RevealResizeObserverCtor)
    : null,
  IntersectionObserverCtor = typeof IntersectionObserver < "u"
    ? (IntersectionObserver as unknown as RevealIntersectionObserverCtor)
    : null,
  stalePointerMs = 900,
}: AttachRevealRefreshOptions = {}): () => void {
  const offs: Array<() => void> = [];
  const add = (
    o: RevealEventTargetLike | null | undefined,
    e: string,
    f: () => void,
    op?: boolean | AddEventListenerOptions
  ): void => {
    if (!o?.addEventListener) return;
    o.addEventListener(e, f, op);
    offs.push(() => o.removeEventListener?.(e, f));
  };

  if (ResizeObserverCtor && target) {
    const r0 = target.getBoundingClientRect?.();
    let col = !!r0 && (r0.width <= 0 || r0.height <= 0);
    const ro = new ResizeObserverCtor((es) => {
      const rc = es?.[es.length - 1]?.contentRect || target.getBoundingClientRect?.();
      if (!rc) return;
      const c = rc.width <= 0 || rc.height <= 0;
      if (col && !c) onReveal?.("resize");
      col = c;
    });
    ro.observe(target);
    offs.push(() => ro.disconnect());
  }

  if (IntersectionObserverCtor && target) {
    let v = typeof doc?.hidden === "boolean" && !doc.hidden;
    const io = new IntersectionObserverCtor(
      (es) => {
        const e = es?.[es.length - 1];
        if (!e) return;
        const n = !!e.isIntersecting;
        if (!v && n) onReveal?.("intersection");
        v = n;
      },
      { threshold: 0 }
    );
    io.observe(target);
    offs.push(() => io.disconnect());
  }

  add(doc, "visibilitychange", () => poller?.handleVisibilityChange?.(doc?.hidden));
  add(win, "focus", () => onReveal?.("focus"));
  add(win, "pageshow", () => onReveal?.("pageshow"));
  add(
    target,
    "pointerenter",
    () => {
      if (!poller?.isStale || poller.isStale(stalePointerMs)) onReveal?.("pointerenter");
    },
    { passive: true }
  );

  return (): void => {
    for (const f of offs) {
      try {
        f();
      } catch {}
    }
    offs.length = 0;
  };
}
