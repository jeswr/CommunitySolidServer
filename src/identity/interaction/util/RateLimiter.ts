export interface RateLimiterArgs {
  /**
   * The maximum number of actions that are allowed for a single key within one window.
   */
  maxCount: number;
  /**
   * The duration of a window in milliseconds, starting at the first counted action for a key.
   */
  windowMs: number;
}

/**
 * A single fixed window for a specific key.
 */
interface RateLimitEntry {
  count: number;
  expiration: number;
}

/**
 * A simple fixed-window rate limiter:
 * every key can be {@link increment}ed up to `maxCount` times within a window of `windowMs` milliseconds,
 * after which the counter for that key resets.
 * Note that all state is kept in memory and is thus per-process,
 * so a multi-instance deployment would need a shared storage backend to be effective.
 */
export class RateLimiter {
  private readonly maxCount: number;
  private readonly windowMs: number;
  private readonly entries: Map<string, RateLimitEntry>;

  public constructor(args: RateLimiterArgs) {
    this.maxCount = args.maxCount;
    this.windowMs = args.windowMs;
    this.entries = new Map<string, RateLimitEntry>();
  }

  /**
   * Whether a new action is currently allowed for the given key.
   *
   * @param key - The key to check.
   *
   * @returns `true` if the key is still within its limit.
   */
  public isAllowed(key: string): boolean {
    const entry = this.getActiveEntry(key);
    return !entry || entry.count < this.maxCount;
  }

  /**
   * Records an action against the given key.
   *
   * @param key - The key to increment.
   */
  public increment(key: string): void {
    const entry = this.getActiveEntry(key);
    if (entry) {
      entry.count += 1;
    } else {
      this.entries.set(key, { count: 1, expiration: Date.now() + this.windowMs });
    }
  }

  /**
   * Clears any recorded actions for the given key.
   *
   * @param key - The key to reset.
   */
  public reset(key: string): void {
    this.entries.delete(key);
  }

  private getActiveEntry(key: string): RateLimitEntry | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiration <= Date.now()) {
      // Removing the expired entry resets the window
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }
}
