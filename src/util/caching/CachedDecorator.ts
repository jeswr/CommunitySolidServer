import type { PromiseCacheStore } from './PromiseCache';
import { PromiseCache } from './PromiseCache';

/**
 * Options for the {@link cached} method decorator.
 *
 * @typeParam TThis - Type of the instance the decorated method belongs to.
 * @typeParam TArgs - Argument tuple of the decorated method.
 */
export interface CachedOptions<TThis, TArgs extends unknown[]> {
  /**
   * Derives the cache key from the arguments of the decorated method.
   * Defaults to using the first argument as key.
   */
  readonly key?: (this: TThis, ...args: TArgs) => unknown;
  /**
   * Whether to back the per-instance cache with a `WeakMap` instead of a `Map`.
   * A `WeakMap` keys entries on object identity and lets them be garbage collected once the key is unreachable,
   * which requires the cache key to be an object and is the memory-safe choice for request-scoped keys.
   * Defaults to `false`, using a `Map` that caches for the lifetime of the instance.
   */
  readonly weak?: boolean;
  /**
   * Whether an entry whose promise rejects is evicted so the call is retried next time.
   * Defaults to `true`.
   */
  readonly evictOnError?: boolean;
}

/**
 * Method decorator that memoizes an asynchronous method with a {@link PromiseCache},
 * making the widely repeated "look up a cached promise, otherwise compute and cache it" pattern
 * a single, minimally invasive annotation.
 *
 * Each instance gets its own cache, so instances never share cached results.
 * The returned promise is cached (not just its resolved value),
 * so concurrent calls with the same key deduplicate onto a single in-flight computation.
 *
 * By default the first argument is used as cache key and entries live for the lifetime of the instance;
 * use {@link CachedOptions.key} to derive the key differently
 * and {@link CachedOptions.weak} to instead key entries on object identity in a `WeakMap`.
 *
 * @param options - {@link CachedOptions} controlling the key, backing store, and error eviction.
 *
 * @returns A decorator applying the described caching to the method.
 *
 * @typeParam TThis - Type of the instance the decorated method belongs to.
 * @typeParam TArgs - Argument tuple of the decorated method.
 * @typeParam TValue - Value the decorated method's promise resolves to.
 */
export function cached<TThis extends object, TArgs extends unknown[], TValue>(
  options: CachedOptions<TThis, TArgs> = {},
): (target: (this: TThis, ...args: TArgs) => Promise<TValue>) => (this: TThis, ...args: TArgs) => Promise<TValue> {
  // One cache per instance, keyed on the instance itself so instances never share results.
  const caches = new WeakMap<TThis, PromiseCache<unknown, TValue>>();

  return (target: (this: TThis, ...args: TArgs) => Promise<TValue>):
  (this: TThis, ...args: TArgs) => Promise<TValue> =>
    async function(this: TThis, ...args: TArgs): Promise<TValue> {
      let cache = caches.get(this);
      if (!cache) {
        // A WeakMap only accepts object keys, which the caller opts into via `weak`;
        // the cast mirrors that the key type is only known to be an object at that call site.
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
