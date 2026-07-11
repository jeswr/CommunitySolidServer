/**
 * The subset of the `Map`/`WeakMap` API that a {@link PromiseCache} uses to store its entries,
 * allowing a cache to be backed by either of them.
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
   * Whether an entry whose promise rejects is removed from the cache,
   * so the failed computation is retried on the next call.
   * Defaults to `true`.
   */
  readonly evictOnError?: boolean;
}

/**
 * Caches asynchronous computations by key.
 * The promise is cached rather than its resolved value,
 * so concurrent calls for the same key share a single in-flight computation.
 * The injected {@link PromiseCacheStore} determines the entry lifetime:
 * a `Map` (the default) keeps entries for the lifetime of this object,
 * while a `WeakMap` lets them be garbage collected once their key object is unreachable.
 */
export class PromiseCache<TKey, TValue> {
  private readonly store: PromiseCacheStore<TKey, Promise<TValue>>;
  private readonly evictOnError: boolean;

  /**
   * @param store - Backing store for the cached promises. Defaults to a new `Map`.
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
   * or creates and caches a new one with the given factory on a cache miss.
   *
   * @param key - Key to look up.
   * @param createPromise - Factory generating the promise on a cache miss.
   */
  public async getOrCreate(key: TKey, createPromise: (key: TKey) => Promise<TValue>): Promise<TValue> {
    const cached = this.store.get(key);
    if (cached) {
      return cached;
    }

    const promise = createPromise(key);
    this.store.set(key, promise);
    if (this.evictOnError) {
      promise.catch((): void => {
        this.store.delete(key);
      });
    }
    return promise;
  }
}
