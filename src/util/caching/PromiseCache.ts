/**
 * The subset of the `Map`/`WeakMap` API that a {@link PromiseCache} uses to store its entries.
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
   * Whether an entry whose promise rejects is evicted so the computation is retried on the next call.
   * Defaults to `true`.
   */
  readonly evictOnError?: boolean;
}

/**
 * Caches the promises of asynchronous, keyed computations,
 * so concurrent callers requesting the same key share a single in-flight computation.
 * The backing {@link PromiseCacheStore} determines the lifetime of the entries:
 * a `Map` (the default) caches them for the lifetime of this object,
 * while a `WeakMap` keyed on object identity lets them be garbage collected once their key is unreachable.
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
   * creating and caching it with the provided factory on a cache miss.
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
