import type { PromiseCacheStore } from './PromiseCache';
import { PromiseCache } from './PromiseCache';

/**
 * Options for the {@link cached} method decorator.
 */
export interface CachedOptions<TThis, TArgs extends unknown[]> {
  /**
   * Derives the cache key from the arguments of the decorated method.
   * Defaults to using the first argument as key.
   */
  readonly key?: (this: TThis, ...args: TArgs) => unknown;
  /**
   * Whether to back the cache with a `WeakMap` instead of a `Map`,
   * keying entries on object identity and letting them be garbage collected once their key is unreachable.
   * Defaults to `false`.
   */
  readonly weak?: boolean;
  /**
   * Whether an entry whose promise rejects is evicted so the call is retried next time.
   * Defaults to `true`.
   */
  readonly evictOnError?: boolean;
}

/**
 * Method decorator that memoizes an asynchronous method with a {@link PromiseCache}.
 * Each instance gets its own cache, so instances never share results.
 * The promise itself is cached, so concurrent calls with the same key share a single in-flight computation.
 * By default the first argument is used as cache key.
 *
 * @param options - {@link CachedOptions} controlling the key, backing store, and error eviction.
 *
 * @returns A decorator applying the described caching to the method.
 */
export function cached<TThis extends object, TArgs extends unknown[], TValue>(
  options: CachedOptions<TThis, TArgs> = {},
): (target: (this: TThis, ...args: TArgs) => Promise<TValue>) => (this: TThis, ...args: TArgs) => Promise<TValue> {
  const caches = new WeakMap<TThis, PromiseCache<unknown, TValue>>();

  return (target: (this: TThis, ...args: TArgs) => Promise<TValue>):
  (this: TThis, ...args: TArgs) => Promise<TValue> =>
    async function(this: TThis, ...args: TArgs): Promise<TValue> {
      let cache = caches.get(this);
      if (!cache) {
        // A WeakMap only accepts object keys, which the caller opts into with the `weak` option
        const store = options.weak ?
          new WeakMap<object, Promise<TValue>>() as unknown as PromiseCacheStore<unknown, Promise<TValue>> :
          new Map<unknown, Promise<TValue>>();
        cache = new PromiseCache<unknown, TValue>(store, { evictOnError: options.evictOnError });
        caches.set(this, cache);
      }
      const key = options.key ? options.key.apply(this, args) : args[0];
      return cache.getOrCreate(key, async(): Promise<TValue> => target.apply(this, args));
    };
}
