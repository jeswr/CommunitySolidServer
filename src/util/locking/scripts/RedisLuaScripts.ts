import type { Callback, Redis } from 'ioredis';
import { InternalServerError } from '../../errors/InternalServerError';

const SUFFIX_WLOCK = '.wlock';
const SUFFIX_LOCK = '.lock';
const SUFFIX_COUNT = '.count';
const LOCKED = 'locked';

/**
 * Lua scripts to be used as Redis operations.
 */
export const REDIS_LUA_SCRIPTS = {
  acquireReadLock: `
    -- Return 0 if an entry already exists.
    local lockKey = KEYS[1].."${SUFFIX_WLOCK}"
    if redis.call("exists", lockKey) == 1 then
      return 0
    end

    -- Increment the read counter and refresh its TTL (in ms, ARGV[1]); return 1 on success (Lua true becomes 1)
    local countKey = KEYS[1].."${SUFFIX_COUNT}"
    local count = redis.call("incr", countKey)
    redis.call("pexpire", countKey, ARGV[1])
    return count > 0
    `,
  acquireWriteLock: `
    -- Return 0 if a lock entry already exists or read count is > 0
    local lockKey = KEYS[1].."${SUFFIX_WLOCK}"
    local countKey = KEYS[1].."${SUFFIX_COUNT}"
    local count = tonumber(redis.call("get", countKey))
    if ((redis.call("exists", lockKey) == 1) or (count ~= nil and count > 0)) then
      return 0
    end

    -- Set the lock with a TTL (in ms, ARGV[1]) and respond with 'OK' if succeeded (otherwise null)
    return redis.call("set", lockKey, "${LOCKED}", "PX", ARGV[1]);
    `,
  releaseReadLock: `
      -- Return 1 after decreasing the counter, if counter is < 0 now: return '-ERR'
      local countKey = KEYS[1].."${SUFFIX_COUNT}"
      local result = redis.call("decr", countKey)
      if result >= 0 then
        return 1
      else 
        return redis.error_reply("Error trying to release readlock when read count was 0.")
      end
    `,
  releaseWriteLock: `
      -- Release the lock and reply with 1 if succeeded (otherwise return '-ERR')
      local lockKey = KEYS[1].."${SUFFIX_WLOCK}"
      local result = redis.call("del", lockKey)
      if (result > 0) then
        return 1
      else
        return redis.error_reply("Error trying to release writelock that did not exist.")
      end
    `,
  renewReadLock: `
      -- Refresh the read counter TTL (in ms, ARGV[1]); return 1 if refreshed, 0 if it did not exist
      local countKey = KEYS[1].."${SUFFIX_COUNT}"
      return redis.call("pexpire", countKey, ARGV[1])
      `,
  renewWriteLock: `
      -- Refresh the write lock TTL (in ms, ARGV[1]); return 1 if refreshed, 0 if it did not exist
      local lockKey = KEYS[1].."${SUFFIX_WLOCK}"
      return redis.call("pexpire", lockKey, ARGV[1])
      `,
  acquireLock: `
      -- Return 0 if lock entry already exists, or 'OK' if it succeeds in setting the lock entry.
      local key = KEYS[1].."${SUFFIX_LOCK}"
      if redis.call("exists", key) == 1 then
        return 0
      end

      -- Set the lock with a TTL (in ms, ARGV[1]) and return 'OK' if succeeded
      return redis.call("set", key, "${LOCKED}", "PX", ARGV[1]);
      `,
  releaseLock: `
      -- Release the lock and reply with 1 if succeeded (otherwise return '-ERR')
      local key = KEYS[1].."${SUFFIX_LOCK}"
      local result = redis.call("del", key)
      if result > 0 then
        return 1
      else
        return redis.error_reply("Error trying to release lock that did not exist.")
      end
    `,
  renewLock: `
      -- Refresh the lock TTL (in ms, ARGV[1]); return 1 if refreshed, 0 if it did not exist
      local key = KEYS[1].."${SUFFIX_LOCK}"
      return redis.call("pexpire", key, ARGV[1])
      `,
} as const;

export type RedisAnswer = 0 | 1 | null | string;

/**
 * Convert a RESP2 response to a boolean.
 *
 * @param result - The Promise-wrapped result of a RESP2 Redis function.
 *
 * @returns * `1`, `'OK'`: return `true`
 *          * `0`: returns `false`
 *          * `-ERR`: throw error
 *
 * @throws On `-ERR*` `null` or any other value
 */
export async function fromResp2ToBool(result: Promise<RedisAnswer>): Promise<boolean> {
  const res = await result;
  switch (res) {
    case 1:
    case 'OK':
      return true;
    case 0:
      return false;
    case null:
      throw new Error('Redis operation error detected (value was null).');
    default:
      if (res.startsWith('-ERR')) {
        throw new InternalServerError(`Redis error: ${res.slice(5)}`);
      } else {
        throw new InternalServerError(`Unexpected Redis answer received! (${res})`);
      }
  }
}

export interface RedisReadWriteLock extends Redis {
  /**
   * Try to acquire a readLock on `resourceIdentifierPath`.
   * Will succeed if there are no write locks.
   *
   * @param ttl - Time-to-live (in ms) of the read counter.
   *
   * @returns 1 if succeeded. 0 if not possible.
   */
  acquireReadLock: (resourceIdentifierPath: string, ttl: number, callback?: Callback<string>) => Promise<RedisAnswer>;

  /**
   * Try to acquire a writeLock on `resourceIdentifierPath`.
   * Only works if no other write lock is present and the read counter is 0.
   *
   * @param ttl - Time-to-live (in ms) of the write lock.
   *
   * @returns 'OK' if succeeded, 0 if not possible.
   */
  acquireWriteLock: (resourceIdentifierPath: string, ttl: number, callback?: Callback<string>) => Promise<RedisAnswer>;

  /**
   * Refresh the TTL of the read counter of a held read lock.
   *
   * @param ttl - New time-to-live (in ms).
   *
   * @returns 1 if the TTL was refreshed, 0 if the counter no longer exists.
   */
  renewReadLock: (resourceIdentifierPath: string, ttl: number, callback?: Callback<number>) => Promise<RedisAnswer>;

  /**
   * Refresh the TTL of a held write lock.
   *
   * @param ttl - New time-to-live (in ms).
   *
   * @returns 1 if the TTL was refreshed, 0 if the lock no longer exists.
   */
  renewWriteLock: (resourceIdentifierPath: string, ttl: number, callback?: Callback<number>) => Promise<RedisAnswer>;

  /**
   * Release readLock. This means decrementing the read counter with 1.
   *
   * @returns 1 if succeeded. '-ERR' if read count goes below 0
   */
  releaseReadLock: (resourceIdentifierPath: string, callback?: Callback<string>) => Promise<RedisAnswer>;

  /**
   * Release writeLock. This means deleting the write lock.
   *
   * @returns 1 if succeeded. '-ERR' if write lock was non-existing.
   */
  releaseWriteLock: (resourceIdentifierPath: string, callback?: Callback<string>) => Promise<RedisAnswer>;
}

export interface RedisResourceLock extends Redis {
  /**
   * Try to acquire a lock  on `resourceIdentifierPath`.
   * Only works if no other lock is present.
   *
   * @param ttl - Time-to-live (in ms) of the lock.
   *
   * @returns 'OK' if succeeded, 0 if not possible.
   */
  acquireLock: (resourceIdentifierPath: string, ttl: number, callback?: Callback<string>) => Promise<RedisAnswer>;

  /**
   * Refresh the TTL of a held lock.
   *
   * @param ttl - New time-to-live (in ms).
   *
   * @returns 1 if the TTL was refreshed, 0 if the lock no longer exists.
   */
  renewLock: (resourceIdentifierPath: string, ttl: number, callback?: Callback<number>) => Promise<RedisAnswer>;

  /**
   * Release lock. This means deleting the lock.
   *
   * @returns 1 if succeeded. '-ERR' if lock was non-existing.
   */
  releaseLock: (resourceIdentifierPath: string, callback?: Callback<string>) => Promise<RedisAnswer>;
}
