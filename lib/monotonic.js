import { performance } from 'node:perf_hooks';

const HOST_STALL_TICK_MS = 25;
const HOST_STALL_THRESHOLD_MS = 100;
let hostStallMonitor;

function ensureHostStallMonitor() {
  if (hostStallMonitor) return hostStallMonitor;
  let lastAt = performance.now();
  let stalledMs = 0;
  const sample = () => {
    const current = performance.now();
    const excess = Math.max(0, current - lastAt - HOST_STALL_TICK_MS);
    if (excess >= HOST_STALL_THRESHOLD_MS) stalledMs += excess;
    lastAt = current;
    return stalledMs;
  };
  const timer = setInterval(sample, HOST_STALL_TICK_MS);
  timer.unref?.();
  hostStallMonitor = { sample };
  return hostStallMonitor;
}

/** Return process-wide synchronous main-thread stalls detected by the sampler. */
export function hostStalledMs() {
  return ensureHostStallMonitor().sample();
}

/** Return a clock that measures elapsed real time and ignores wall-clock jumps. */
export function createStopwatch(now = () => performance.now(), options = {}) {
  if (typeof now !== 'function') throw new TypeError('单调时钟必须是函数');
  const started = Number(now());
  if (!Number.isFinite(started)) throw new TypeError('单调时钟起点无效');
  const excludeHostStalls = options?.excludeHostStalls === true;
  const maxStallCreditMs = excludeHostStalls ? Number(options.maxStallCreditMs ?? 10000) : 0;
  if (!Number.isFinite(maxStallCreditMs) || maxStallCreditMs < 0) {
    throw new TypeError('卡顿扣除上限无效');
  }
  const stallStartedAt = excludeHostStalls ? hostStalledMs() : 0;
  return () => {
    const current = Number(now());
    if (!Number.isFinite(current)) return Number.POSITIVE_INFINITY;
    const elapsed = Math.max(0, current - started);
    if (!excludeHostStalls) return elapsed;
    const stallCredit = Math.min(maxStallCreditMs, Math.max(0, hostStalledMs() - stallStartedAt));
    return Math.max(0, elapsed - stallCredit);
  };
}

/** Recheck remaining time whenever the timer wakes up, including after a host stall. */
export function deadlineTimer(remainingMs, onExpire) {
  if (typeof remainingMs !== 'function' || typeof onExpire !== 'function') {
    throw new TypeError('截止计时器需要剩余时间和到期回调');
  }
  let timer;
  let cancelled = false;
  const remaining = () => {
    const value = Number(remainingMs());
    if (!Number.isFinite(value)) throw new TypeError('截止剩余时间无效');
    return Math.max(0, value);
  };
  const check = () => {
    if (cancelled) return;
    const left = remaining();
    if (left > 1) timer = setTimeout(check, left);
    else onExpire();
  };
  timer = setTimeout(check, remaining());
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}

/** A timeout signal whose checks use a monotonic job-time budget. */
export function deadlineSignal(remainingMs) {
  const controller = new AbortController();
  const cancel = deadlineTimer(remainingMs, () => {
    if (!controller.signal.aborted) {
      controller.abort(new DOMException('Memory deadline reached', 'TimeoutError'));
    }
  });
  return { signal: controller.signal, cancel };
}

/** Leave enough time to validate and pack whatever the search lanes found. */
export function searchFinalizationReserveMs(waitMs) {
  const total = Number(waitMs);
  if (!Number.isFinite(total)) return 300;
  return Math.max(300, Math.max(0, total) * 0.1);
}
