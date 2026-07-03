import Redis from 'ioredis';
import type { ResourceIdentifier } from '../../http/representation/ResourceIdentifier';
import type { Finalizable } from '../../init/final/Finalizable';
import type { Initializable } from '../../init/Initializable';
import { getLoggerFor } from '../../logging/LogUtil';
import { createErrorMessage } from '../errors/ErrorUtil';
import type { AttemptSettings } from '../LockUtils';
import { retryFunction } from '../LockUtils';
import type { PromiseOrValue } from '../PromiseUtil';
import type { ReadWriteLocker } from './ReadWriteLocker';
import type { ResourceLocker } from './ResourceLocker';
import type { RedisAnswer, RedisReadWriteLock, RedisResourceLock } from './scripts/RedisLuaScripts';
import { fromResp2ToBool, REDIS_LUA_SCRIPTS } from './scripts/RedisLuaScripts';

const attemptDefaults: Required<AttemptSettings> = { retryCount: -1, retryDelay: 50, retryJitter: 30 };

// Internal prefix for Redis keys;
const PREFIX_RW = '__RW__';
const PREFIX_LOCK = '__L__';

/**
 * Default time-to-live (in ms) for a Redis lock key.
 *
 * A crashed lock holder's key auto-expires after this time so that other instances cannot deadlock
 * on the abandoned resource. It is deliberately several times larger than the in-process lock
 * expiration (see {@link WrappedExpiringReadWriteLocker}, 6000ms by default), and it is actively
 * renewed while a lock is legitimately held, so a normal operation never loses its lock.
 */
const DEFAULT_TTL = 30000;

export interface RedisSettings {
  /* Override default namespacePrefixes (used to prefix keys in Redis) */
  namespacePrefix?: string;
  /* Username used for AUTH on the Redis server */
  username?: string;
  /* Password used for AUTH on the Redis server */
  password?: string;
  /* The number of the database to use */
  db?: number;
  /**
   * Time-to-live (in ms) for the Redis lock keys. A crashed holder's key auto-expires after this
   * time so peers do not deadlock. While a lock is legitimately held it is renewed at half this
   * interval, so this value only bounds how long peers wait after a hard crash. Must be larger than
   * the in-process lock expiration. Defaults to {@link DEFAULT_TTL} (30000ms).
   */
  ttl?: number;
  /**
   * Whether to delete every lock in this namespace when the locker starts (see {@link RedisLocker.initialize}).
   *
   * This is only safe when a single instance exclusively owns the Redis namespace: it lets that
   * instance recover from locks left behind by a previous crashed run. When multiple instances share
   * a namespace (the setup required for HA coordination) a restarting instance cannot tell its own
   * stale locks from the live locks of its peers, so wiping the namespace on boot would corrupt peers
   * that still hold those locks. Because a crashed holder's lock now auto-expires through its TTL lease
   * (see {@link RedisSettings.ttl}), boot-time clearing is no longer needed for correctness, so this
   * defaults to `false` (multi-instance-safe). Set it to `true` for a single-instance deployment that
   * prefers stale locks cleared immediately on boot rather than waiting for the TTL to elapse.
   */
  clearLocksOnStart?: boolean;
}

/**
 * A Redis Locker that can be used as both:
 *  *  a Read Write Locker that uses a (single) Redis server to store the locks and counts.
 *  *  a Resource Locker that uses a (single) Redis server to store the lock.
 * This solution should be process-safe. The only references to locks are string keys
 * derived from identifier paths.
 *
 * The Read Write algorithm roughly goes as follows:
 *  * Acquire a read lock: allowed as long as there is no write lock. On acquiring the read counter goes up.
 *  * Acquire a write lock: allowed as long as there is no other write lock AND the read counter is 0.
 *  * Release a read lock: decreases the read counter with 1
 *  * Release a write lock: unlocks the write lock
 *
 * The Resource locking algorithm uses a single mutex/lock.
 *
 * All operations, such as checking for a write lock AND read count, are executed in a single Lua script.
 * These scripts are used by Redis as a single new command.
 * Redis executes its operations in a single thread, as such, each such operation can be considered atomic.
 *
 * The operation to (un)lock will always resolve with either 1/OK/true if succeeded or 0/false if not succeeded.
 * Rejection with errors will be happen on actual failures. Retrying the (un)lock operations will be done by making
 * use of the LockUtils' {@link retryFunctionUntil} function.
 *
 * * @see [Redis Commands documentation](https://redis.io/commands/)
 * * @see [Redis Lua scripting documentation](https://redis.io/docs/manual/programmability/)
 * * @see [ioredis Lua scripting API](https://github.com/luin/ioredis#lua-scripting)
 */
export class RedisLocker implements ReadWriteLocker, ResourceLocker, Initializable, Finalizable {
  protected readonly logger = getLoggerFor(this);

  private readonly redis: Redis;
  private readonly redisRw: RedisReadWriteLock;
  private readonly redisLock: RedisResourceLock;
  private readonly attemptSettings: Required<AttemptSettings>;
  private readonly namespacePrefix: string;
  private readonly ttl: number;
  private readonly clearLocksOnStart: boolean;
  private readonly renewalInterval: number;
  private readonly renewalTimers = new Map<string, NodeJS.Timeout>();
  private finalized = false;

  /**
   * Creates a new RedisClient
   *
   * @param redisClient - Redis connection string of a standalone Redis node
   * @param attemptSettings - Override default AttemptSettings
   * @param redisSettings - Addition settings used to create the Redis client or to interact with the Redis server
   */
  public constructor(
    redisClient = '127.0.0.1:6379',
    attemptSettings: AttemptSettings = {},
    redisSettings?: RedisSettings,
  ) {
    redisSettings = { namespacePrefix: '', ...redisSettings };
    const { namespacePrefix, ttl, clearLocksOnStart, ...options } = redisSettings;
    this.redis = this.createRedisClient(redisClient, options);
    this.attemptSettings = { ...attemptDefaults, ...attemptSettings };
    this.namespacePrefix = namespacePrefix!;
    this.ttl = ttl ?? DEFAULT_TTL;
    // Default to NOT wiping the namespace on boot so peers sharing it (HA) are never disturbed.
    this.clearLocksOnStart = clearLocksOnStart ?? false;
    // Renew at half the TTL so a live holder refreshes its lock long before it could expire.
    this.renewalInterval = Math.max(1, Math.floor(this.ttl / 2));

    // Register lua scripts
    for (const [ name, script ] of Object.entries(REDIS_LUA_SCRIPTS)) {
      this.redis.defineCommand(name, { numberOfKeys: 1, lua: script });
    }

    this.redisRw = this.redis as RedisReadWriteLock;
    this.redisLock = this.redis as RedisResourceLock;
  }

  /**
   * Generate and return a RedisClient based on the provided string
   *
   * @param redisClientString - A string that contains either a host address and a
   *                            port number like '127.0.0.1:6379' or just a port number like '6379'.
   */
  private createRedisClient(
    redisClientString: string,
    options: Omit<RedisSettings, 'namespacePrefix' | 'ttl' | 'clearLocksOnStart'>,
  ): Redis {
    if (redisClientString.length > 0) {
      // Check if port number or ip with port number
      // Definitely not perfect, but configuring this is only for experienced users
      const match = /^(?:([^:]+):)?(\d{4,5})$/u.exec(redisClientString);
      if (!match?.[2]) {
        // At least a port number should be provided
        throw new Error(`Invalid data provided to create a Redis client: ${redisClientString}\n
            Please provide a port number like '6379' or a host address and a port number like '127.0.0.1:6379'`);
      }
      const port = Number(match[2]);
      const host = match[1];
      return new Redis(port, host, options);
    }
    throw new Error(`Empty redisClientString provided!\n
            Please provide a port number like '6379' or a host address and a port number like '127.0.0.1:6379'`);
  }

  /**
   * Create a scoped Redis key for Read-Write locking.
   *
   * @param identifier - The identifier object to create a Redis key for
   *
   * @returns A scoped Redis key that allows cleanup afterwards without affecting other keys.
   */
  private getReadWriteKey(identifier: ResourceIdentifier): string {
    return `${this.namespacePrefix}${PREFIX_RW}${identifier.path}`;
  }

  /**
   * Create a scoped Redis key for Resource locking.
   *
   * @param identifier - The identifier object to create a Redis key for
   *
   * @returns A scoped Redis key that allows cleanup afterwards without affecting other keys.
   */
  private getResourceKey(identifier: ResourceIdentifier): string {
    return `${this.namespacePrefix}${PREFIX_LOCK}${identifier.path}`;
  }

  /* Lease renewal */

  /**
   * Creates an interval timer that periodically refreshes the TTL of a held Redis lock (a lease).
   * As long as the process is alive the lock keeps being renewed, so a legitimate (even long-running)
   * operation never loses its lock. Once the process crashes the timer dies with it and the Redis key
   * expires after the TTL, releasing the abandoned lock so peers do not deadlock.
   *
   * @param renew - Refreshes the TTL of the relevant Redis key. Rejections are swallowed and logged,
   *                as a single missed refresh is recovered by the next interval tick.
   *
   * @returns The interval timer, which must be cleared with {@link clearInterval} once the lock is released.
   */
  private createRenewalTimer(renew: () => Promise<RedisAnswer>): NodeJS.Timeout {
    const timer = setInterval((): void => {
      renew().catch((error: unknown): void => {
        this.logger.warn(`Could not renew Redis lock TTL: ${createErrorMessage(error)}`);
      });
    }, this.renewalInterval);
    // A background renewal timer should never keep the Node.js process alive on its own.
    timer.unref();
    return timer;
  }

  /**
   * Starts renewing the TTL of a resource lock and tracks the timer so it can be stopped on release.
   *
   * @param key - The Redis key of the acquired resource lock.
   * @param renew - Refreshes the TTL of the resource lock key.
   */
  private startRenewal(key: string, renew: () => Promise<RedisAnswer>): void {
    this.stopRenewal(key);
    this.renewalTimers.set(key, this.createRenewalTimer(renew));
  }

  /**
   * Stops renewing the TTL of a resource lock, if a renewal timer is active for the given key.
   *
   * @param key - The Redis key of the resource lock to stop renewing.
   */
  private stopRenewal(key: string): void {
    const timer = this.renewalTimers.get(key);
    if (timer) {
      clearInterval(timer);
      this.renewalTimers.delete(key);
    }
  }

  /* ReadWriteLocker methods */

  /**
   * Wrapper function for all (un)lock operations. If the `fn()` resolves to false (after applying
   * {@link fromResp2ToBool}, the result will be swallowed. When `fn()` resolves to true, this wrapper
   * will return true. Any error coming from `fn()` will be thrown.
   *
   * @param fn - The function reference to swallow false from.
   */
  private swallowFalse(fn: () => Promise<RedisAnswer>): () => Promise<unknown> {
    if (this.finalized) {
      throw new Error('Invalid state: cannot execute Redis operation once finalize() has been called.');
    }
    return async(): Promise<unknown> => {
      const result = await fromResp2ToBool(fn());
      // Swallow any result resolving to `false`
      if (result) {
        return true;
      }
    };
  }

  public async withReadLock<T>(identifier: ResourceIdentifier, whileLocked: () => PromiseOrValue<T>): Promise<T> {
    const key = this.getReadWriteKey(identifier);
    await retryFunction(
      this.swallowFalse(this.redisRw.acquireReadLock.bind(this.redisRw, key, this.ttl)),
      this.attemptSettings,
    );
    const renewalTimer = this.createRenewalTimer(
      async(): Promise<RedisAnswer> => this.redisRw.renewReadLock(key, this.ttl),
    );
    try {
      return await whileLocked();
    } finally {
      clearInterval(renewalTimer);
      await retryFunction(
        this.swallowFalse(this.redisRw.releaseReadLock.bind(this.redisRw, key)),
        this.attemptSettings,
      );
    }
  }

  public async withWriteLock<T>(identifier: ResourceIdentifier, whileLocked: () => PromiseOrValue<T>): Promise<T> {
    const key = this.getReadWriteKey(identifier);
    await retryFunction(
      this.swallowFalse(this.redisRw.acquireWriteLock.bind(this.redisRw, key, this.ttl)),
      this.attemptSettings,
    );
    const renewalTimer = this.createRenewalTimer(
      async(): Promise<RedisAnswer> => this.redisRw.renewWriteLock(key, this.ttl),
    );
    try {
      return await whileLocked();
    } finally {
      clearInterval(renewalTimer);
      await retryFunction(
        this.swallowFalse(this.redisRw.releaseWriteLock.bind(this.redisRw, key)),
        this.attemptSettings,
      );
    }
  }

  /* ResourceLocker methods */

  public async acquire(identifier: ResourceIdentifier): Promise<void> {
    const key = this.getResourceKey(identifier);
    await retryFunction(
      this.swallowFalse(this.redisLock.acquireLock.bind(this.redisLock, key, this.ttl)),
      this.attemptSettings,
    );
    // A resource lock is held across separate acquire()/release() calls, so keep renewing its TTL
    // until it is explicitly released (or the process crashes).
    this.startRenewal(key, async(): Promise<RedisAnswer> => this.redisLock.renewLock(key, this.ttl));
  }

  public async release(identifier: ResourceIdentifier): Promise<void> {
    const key = this.getResourceKey(identifier);
    this.stopRenewal(key);
    await retryFunction(
      this.swallowFalse(this.redisLock.releaseLock.bind(this.redisLock, key)),
      this.attemptSettings,
    );
  }

  /* Initializer & Finalizer methods */

  public async initialize(): Promise<void> {
    if (!this.clearLocksOnStart) {
      // Multiple instances may share this namespace to coordinate (HA). This instance cannot tell its
      // own stale locks from the live locks of its peers, so it must NOT wipe the namespace on boot:
      // deleting a peer's held lock would open a corruption window. A crashed holder's lock instead
      // self-heals via its TTL lease. Single-instance deployments can opt back in via `clearLocksOnStart`.
      this.logger.debug('Skipping boot-time lock cleanup; relying on lock TTLs (clearLocksOnStart is disabled).');
      return;
    }
    // On server start (single-instance only): remove all existing (dangling) locks left behind by a
    // previous crashed run, so new requests are not blocked while waiting for those locks' TTLs.
    return this.clearLocks();
  }

  public async finalize(): Promise<void> {
    this.finalized = true;
    // Stop any active resource-lock renewals so their timers cannot outlive the locker.
    for (const timer of this.renewalTimers.values()) {
      clearInterval(timer);
    }
    this.renewalTimers.clear();
    try {
      if (this.clearLocksOnStart) {
        // Single-instance mode (the same mode that wipes on boot): this instance exclusively owns the
        // namespace, so on a controlled shutdown it cleans up every lock it left behind.
        await this.clearLocks();
      } else {
        // Multiple instances may share this namespace to coordinate (HA). A gracefully stopping instance
        // cannot tell its own locks from the live locks of its peers, so it must NOT wipe the namespace on
        // shutdown: deleting a peer's held lock would open the same corruption window as a boot-time wipe.
        // This instance's own locks self-heal via their TTL leases once it stops renewing them above.
        this.logger.debug('Skipping shutdown lock cleanup; relying on lock TTLs (clearLocksOnStart is disabled).');
      }
    } finally {
      // Always quit the redis client, whether or not the namespace was cleared, so no connection leaks.
      await this.redis.quit();
    }
  }

  /**
   * Remove any lock still open
   */
  private async clearLocks(): Promise<void> {
    const keysRw = await this.redisRw.keys(`${this.namespacePrefix}${PREFIX_RW}*`);
    if (keysRw.length > 0) {
      await this.redisRw.del(...keysRw);
    }

    const keysLock = await this.redisLock.keys(`${this.namespacePrefix}${PREFIX_LOCK}*`);
    if (keysLock.length > 0) {
      await this.redisLock.del(...keysLock);
    }
  }
}
