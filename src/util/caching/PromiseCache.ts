/**
 * The subset of the `Map`/`WeakMap` API that a {@link PromiseCache} uses to store its entries.
 * The chosen backing store determines the lifetime of the entries:
 * a `Map` keeps them for as long as the cache exists,
 * while a `WeakMap` keys them on object identity and lets them be garbage collected once the key is unreachable.
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
   * Whether an entry whose promise rejects is evicted so the failed computation is retried on the next call.
   * Defaults to `true`.
   */
  readonly evictOnError?: boolean;
}

/**
 * Caches asynchronous computations by key.
 * The promise itself is cached rather than its resolved value,
 * so concurrent calls for the same key share a single in-flight computation.
 * The injected {@link PromiseCacheStore} determines the lifetime of the entries,
 * and rejected promises are evicted by default so transient failures are retried rather than remembered.
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
   * or uses the factory to create and cache a new one on a cache miss.
   *
   * @param key - Key to look up.
   * @param createPromise - Factory generating the promise on a cache miss. Receives the key.
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
      promise.catch((): void => {
        this.store.delete(key);
      });
    }
    return promise;
  }
}
