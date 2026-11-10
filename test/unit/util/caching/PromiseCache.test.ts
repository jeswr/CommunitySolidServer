import { PromiseCache } from '../../../../src/util/caching/PromiseCache';

describe('A PromiseCache', (): void => {
  it('computes and caches a value on a miss and reuses it on a hit.', async(): Promise<void> => {
    const cache = new PromiseCache<string, number>();
    const factory = jest.fn(async(): Promise<number> => 1);
    await expect(cache.getOrCreate('a', factory)).resolves.toBe(1);
    await expect(cache.getOrCreate('a', factory)).resolves.toBe(1);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('passes the key to the factory.', async(): Promise<void> => {
    const cache = new PromiseCache<string, string>();
    const factory = jest.fn(async(key: string): Promise<string> => `v:${key}`);
    await expect(cache.getOrCreate('a', factory)).resolves.toBe('v:a');
    expect(factory).toHaveBeenLastCalledWith('a');
  });

  it('caches separate values for separate keys.', async(): Promise<void> => {
    const cache = new PromiseCache<string, number>();
    let count = 0;
    const factory = jest.fn(async(): Promise<number> => {
      const value = count;
      count += 1;
      return value;
    });
    await expect(cache.getOrCreate('a', factory)).resolves.toBe(0);
    await expect(cache.getOrCreate('b', factory)).resolves.toBe(1);
    await expect(cache.getOrCreate('a', factory)).resolves.toBe(0);
  });

  it('deduplicates concurrent calls for the same key onto a single computation.', async(): Promise<void> => {
    const cache = new PromiseCache<string, number>();
    const factory = jest.fn(async(): Promise<number> => 42);
    const [ first, second ] = await Promise.all([ cache.getOrCreate('a', factory), cache.getOrCreate('a', factory) ]);
    expect(first).toBe(42);
    expect(second).toBe(42);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('supports a WeakMap backing store keyed on object identity.', async(): Promise<void> => {
    const cache = new PromiseCache<object, number>(new WeakMap());
    const key1 = {};
    const key2 = {};
    let count = 0;
    const factory = jest.fn(async(): Promise<number> => {
      const value = count;
      count += 1;
      return value;
    });
    await expect(cache.getOrCreate(key1, factory)).resolves.toBe(0);
    await expect(cache.getOrCreate(key1, factory)).resolves.toBe(0);
    await expect(cache.getOrCreate(key2, factory)).resolves.toBe(1);
  });

  it('evicts an entry whose promise rejects so it is retried.', async(): Promise<void> => {
    const cache = new PromiseCache<string, number>();
    let calls = 0;
    const factory = jest.fn(async(): Promise<number> => {
      calls += 1;
      if (calls === 1) {
        throw new Error('fail');
      }
      return 5;
    });
    await expect(cache.getOrCreate('a', factory)).rejects.toThrow('fail');
    await expect(cache.getOrCreate('a', factory)).resolves.toBe(5);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('keeps a rejected entry cached when evictOnError is disabled.', async(): Promise<void> => {
    const cache = new PromiseCache<string, number>(new Map(), { evictOnError: false });
    const factory = jest.fn(async(): Promise<number> => {
      throw new Error('fail');
    });
    await expect(cache.getOrCreate('a', factory)).rejects.toThrow('fail');
    await expect(cache.getOrCreate('a', factory)).rejects.toThrow('fail');
    expect(factory).toHaveBeenCalledTimes(1);
  });
});
