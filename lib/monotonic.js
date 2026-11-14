import { performance } from 'node:perf_hooks';

/** Return a clock that measures elapsed real time and ignores wall-clock jumps. */
export function createStopwatch(now = () => performance.now()) {
  if (typeof now !== 'function') throw new TypeError('单调时钟必须是函数');
  const started = Number(now());
  if (!Number.isFinite(started)) throw new TypeError('单调时钟起点无效');
  return () => {
    const current = Number(now());
    if (!Number.isFinite(current)) return Number.POSITIVE_INFINITY;
    return Math.max(0, current - started);
  };
}

/** Leave enough time to validate and pack whatever the search lanes found. */
export function searchFinalizationReserveMs(waitMs) {
  const total = Number(waitMs);
  if (!Number.isFinite(total)) return 300;
  return Math.max(300, Math.max(0, total) * 0.1);
}
