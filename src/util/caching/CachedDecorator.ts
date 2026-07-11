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
   * which requires object keys and lets entries be garbage collected once their key is unreachable.
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
 * Method decorator that memoizes an asynchronous method with a per-instance {@link PromiseCache}.
 * The promise is cached rather than its resolved value,
 * so concurrent calls with the same key share a single in-flight computation.
 * By default the first argument is used as cache key; see {@link CachedOptions} for alternatives.
 *
 * @param options - {@link CachedOptions} controlling the key, backing store, and error eviction.
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
        // The cast is safe since callers setting `weak` commit to object keys
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
