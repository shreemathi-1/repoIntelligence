/**
 * Per-provider budget tracking. Each provider has a one-minute sliding window of requests
 * and tokens, plus a cooldown that a 429 (or an explicit Retry-After) sets.
 */
export interface Limits {
  rpm: number;
  tpm: number;
}

interface Window {
  events: { at: number; tokens: number }[];
  cooldownUntil: number;
}

const MINUTE = 60_000;
const DEFAULT_COOLDOWN_MS = 30_000;

export class RateLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(private readonly now: () => number = Date.now) {}

  private window(key: string): Window {
    let w = this.windows.get(key);
    if (!w) {
      w = { events: [], cooldownUntil: 0 };
      this.windows.set(key, w);
    }
    const cutoff = this.now() - MINUTE;
    w.events = w.events.filter((e) => e.at > cutoff);
    return w;
  }

  /** Milliseconds until a request of `tokens` fits, or 0 when it fits now. */
  waitFor(key: string, limits: Limits, tokens: number): number {
    const w = this.window(key);
    const now = this.now();
    let wait = Math.max(0, w.cooldownUntil - now);
    if (tokens > limits.tpm) return Number.POSITIVE_INFINITY;
    const used = w.events.reduce((sum, e) => sum + e.tokens, 0);
    if (w.events.length >= limits.rpm || used + tokens > limits.tpm) {
      // The window frees up when its oldest event ages out.
      const oldest = w.events[0]?.at ?? now;
      wait = Math.max(wait, oldest + MINUTE - now);
    }
    return wait;
  }

  record(key: string, tokens: number): void {
    this.window(key).events.push({ at: this.now(), tokens });
  }

  /** Holds the provider back after a 429 or an outage. */
  block(key: string, ms = DEFAULT_COOLDOWN_MS): void {
    const w = this.window(key);
    w.cooldownUntil = Math.max(w.cooldownUntil, this.now() + ms);
  }

  snapshot(): Record<string, { requests: number; tokens: number; cooldownMs: number }> {
    const out: Record<string, { requests: number; tokens: number; cooldownMs: number }> = {};
    for (const key of this.windows.keys()) {
      const w = this.window(key);
      out[key] = {
        requests: w.events.length,
        tokens: w.events.reduce((sum, e) => sum + e.tokens, 0),
        cooldownMs: Math.max(0, w.cooldownUntil - this.now()),
      };
    }
    return out;
  }
}
