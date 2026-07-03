export interface RateLimiterArgs {
  /**
   * The maximum number of actions that are allowed for a single key within one window.
   */
  maxCount: number;
  /**
   * The duration of a window in milliseconds.
   * Once this much time has passed since the first counted action, the counter for that key resets.
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
 * A simple in-memory fixed-window rate limiter.
 *
 * Every key (for example an IP address and/or account identifier) is allowed to be {@link increment}ed
 * up to `maxCount` times within a window of `windowMs` milliseconds.
 * After the window expires the counter for that key is reset automatically.
 *
 * Note that the state is kept in-memory and is thus per-process:
 * this is sufficient for a single-instance deployment,
 * but a multi-instance deployment would need a shared storage backend to be effective.
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
   * Whether a new action is currently allowed for the given key, i.e. its limit has not been reached yet.
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
   * Records a single action against the given key within the current window.
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
   * Clears any recorded actions for the given key, for example after a successful login.
   *
   * @param key - The key to reset.
   */
  public reset(key: string): void {
    this.entries.delete(key);
  }

  /**
   * Returns the entry for the given key if it exists and its window has not yet expired.
   * Expired entries are removed so their window effectively resets.
   *
   * @param key - The key to look up.
   *
   * @returns The active entry, or `undefined` if there is none.
   */
  private getActiveEntry(key: string): RateLimitEntry | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiration <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }
}
