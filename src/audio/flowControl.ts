/**
 * Audio data-plane flow control (plan 1.4 `level` throttle, 1.5 back-pressure).
 * Pure — unit-testable.
 */

/** Default cap on the audio WS send buffer before frames are dropped (1 MiB). */
export const DEFAULT_MAX_AUDIO_BUFFER = 1 << 20;

/**
 * Whether to send the next audio frame given the socket's current buffered
 * amount. Real-time audio is loss-tolerant: dropping a frame under back-pressure
 * beats unbounded buffering (implementation-notes Q10).
 */
export function shouldSendFrame(bufferedAmount: number, maxBufferedBytes: number): boolean {
  return bufferedAmount <= maxBufferedBytes;
}

/**
 * Time-based rate limiter for high-frequency emissions (the mic `level` fires
 * per worklet frame — hundreds/sec). Returns a function yielding `true` at most
 * once per `intervalMs` (implementation-notes Q5). `now` is injectable for tests.
 */
export function createRateLimiter(intervalMs: number, now: () => number = () => Date.now()): () => boolean {
  let last = -Infinity;
  return () => {
    const t = now();
    if (t - last >= intervalMs) {
      last = t;
      return true;
    }
    return false;
  };
}
