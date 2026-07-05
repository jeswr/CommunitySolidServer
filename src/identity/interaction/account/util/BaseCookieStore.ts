import { randomUUID } from 'node:crypto';
import type { ExpiringStorage } from '../../../../storage/keyvalue/ExpiringStorage';
import type { CookieStore } from './CookieStore';

/**
 * A {@link CookieStore} that uses an {@link ExpiringStorage} to keep track of the stored cookies.
 * Cookies have a specified time to live in seconds, default is 14 days,
 * after which they will be removed.
 *
 * To avoid a storage write on every refresh,
 * the expiration is only re-persisted when it would advance the stored expiration
 * by more than `refreshThreshold` milliseconds.
 * When the write is skipped, the currently stored expiration is returned,
 * so the expiration communicated to the client always matches the state stored on the server.
 * As the decision is based on the stored expiration,
 * it is consistent across multiple worker threads or server instances sharing the same storage.
 * Setting `refreshThreshold` to 0 disables the throttling entirely,
 * restoring a write on every refresh.
 */
export class BaseCookieStore implements CookieStore {
  private readonly storage: ExpiringStorage<string, string>;
  private readonly ttl: number;
  private readonly refreshThreshold: number;

  /**
   * @param storage - Storage used to store the cookies and their expiration.
   * @param ttl - How long the cookies should stay valid, in seconds. Defaults to 14 days.
   * @param refreshThreshold - How much a refresh needs to advance the stored expiration
   *   before it gets re-persisted, in milliseconds. Defaults to 1 minute.
   *   Set to 0 to persist a fresh expiration on every refresh.
   */
  public constructor(
    storage: ExpiringStorage<string, string>,
    ttl = 14 * 24 * 60 * 60,
    refreshThreshold = 60 * 1000,
  ) {
    this.storage = storage;
    this.ttl = ttl * 1000;
    this.refreshThreshold = refreshThreshold;
  }

  public async generate(accountId: string): Promise<string> {
    const cookie = randomUUID();
    await this.storage.set(cookie, accountId, this.ttl);
    return cookie;
  }

  public async get(cookie: string): Promise<string | undefined> {
    return this.storage.get(cookie);
  }

  public async refresh(cookie: string, accountId?: string): Promise<Date | undefined> {
    // When the caller already knows the account ID (e.g. it just read it), reuse it
    // to avoid a redundant storage read; otherwise look up the mapping ourselves.
    const id = accountId ?? await this.storage.get(cookie);
    if (!id) {
      return;
    }

    if (this.refreshThreshold > 0) {
      // Storages that cannot report the stored expiration fall through to a write on every refresh.
      const stored = await this.storage.getExpiration?.(cookie);
      // Skip the write if it would advance the stored expiration by less than the threshold.
      // Reading the shared stored expiration (instead of tracking writes per instance)
      // keeps this decision consistent across worker threads/instances,
      // and it is much cheaper than the (locked) write it replaces.
      // Returning the *stored* expiration rather than a freshly computed one
      // keeps the `Set-Cookie` expiration sent to the client identical to the server-side state,
      // so the two can never diverge.
      // A session can thus expire at most `refreshThreshold` earlier than without throttling,
      // and its validity is never extended.
      // A negative advance means the stored expiration exceeds a fresh one (e.g. after a TTL reduction),
      // in which case the fresh expiration is persisted, exactly as it would be without throttling.
      if (stored) {
        const advance = Date.now() + this.ttl - stored.getTime();
        if (advance >= 0 && advance <= this.refreshThreshold) {
          return stored;
        }
      }
    }

    await this.storage.set(cookie, id, this.ttl);
    return new Date(Date.now() + this.ttl);
  }

  public async delete(cookie: string): Promise<boolean> {
    return this.storage.delete(cookie);
  }
}
