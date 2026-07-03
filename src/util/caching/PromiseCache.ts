/**
 * The subset of the `Map`/`WeakMap` API that a {@link PromiseCache} uses to store its entries.
 * Both `Map` and `WeakMap` structurally satisfy this interface,
 * which lets a cache be backed by either of them:
 * a `Map` keeps its entries for as long as the cache exists (process-lifetime caching of a bounded key space),
 * while a `WeakMap` keyed on object identity lets entries be garbage collected
 * once their key object becomes unreachable, avoiding unbounded growth.
 */
export interface PromiseCacheStore<TKey, TValue> {
  get: (key: TKey) => TValue | undefined;
  set: (key: TKey, value: TValue) => unknown;
  delete: (key: TKey) => unknown;
}

/**
 * Options for a {@link PromiseCache}.
 */
export interface PromiseCacheOptions {
  /**
   * Whether an entry whose promise rejects is removed from the cache as soon as it rejects,
   * so the failed computation is retried on the next call instead of being remembered.
   * Defaults to `true`.
   */
  readonly evictOnError?: boolean;
}

/**
 * A small, reusable cache for asynchronous, keyed computations.
 *
 * The *promise* returned by the factory is cached rather than its resolved value,
 * so concurrent callers requesting the same key share a single in-flight computation and deduplicate,
 * instead of each starting their own.
 *
 * The cache is backed by an injected {@link PromiseCacheStore}, allowing the caller to pick the lifetime:
 * a `Map` (the default) caches for the lifetime of this object, which suits a bounded set of keys,
 * whereas a `WeakMap` keyed on object identity lets entries be collected once their key is unreachable,
 * which suits keys scoped to, for example, a single request.
 *
 * By default an entry whose promise rejects is evicted (see {@link PromiseCacheOptions.evictOnError}),
 * so transient failures are retried rather than cached.
 */
export class PromiseCache<TKey, TValue> {
  private readonly store: PromiseCacheStore<TKey, Promise<TValue>>;
  private readonly evictOnError: boolean;

  /**
   * @param store - Backing store for the cached promises. Defaults to a new `Map`, which caches
   *                entries for the lifetime of this object. Pass a `WeakMap` to instead key entries
   *                on object identity and let them be garbage collected once the key is unreachable.
   * @param options - Additional {@link PromiseCacheOptions}.
   */
  public constructor(
    store: PromiseCacheStore<TKey, Promise<TValue>> = new Map<TKey, Promise<TValue>>(),
    options: PromiseCacheOptions = {},
  ) {
    this.store = store;
    this.evictOnError = options.evictOnError ?? true;
  }

  /**
   * Returns the cached promise for the given key,
   * or, on a cache miss, creates a new promise with the provided factory, caches it, and returns it.
   *
   * @param key - Key to look up.
   * @param createPromise - Factory generating the promise on a cache miss. It receives the key.
   *
   * @returns The cached or newly created promise.
   */
  public async getOrCreate(key: TKey, createPromise: (key: TKey) => Promise<TValue>): Promise<TValue> {
    const cached = this.store.get(key);
    if (cached) {
      return cached;
    }

    const promise = createPromise(key);
    this.store.set(key, promise);
    if (this.evictOnError) {
      // Evict a rejected entry so the failed computation is retried on the next call.
      promise.catch((): void => {
        this.store.delete(key);
      });
    }
    return promise;
  }
}
