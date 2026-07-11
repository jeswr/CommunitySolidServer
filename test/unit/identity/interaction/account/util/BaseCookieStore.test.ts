import crypto from 'node:crypto';
import { BaseCookieStore } from '../../../../../../src/identity/interaction/account/util/BaseCookieStore';
import type { ExpiringStorage } from '../../../../../../src/storage/keyvalue/ExpiringStorage';
import { MemoryMapStorage } from '../../../../../../src/storage/keyvalue/MemoryMapStorage';
import type { Expires } from '../../../../../../src/storage/keyvalue/WrappedExpiringStorage';
import { WrappedExpiringStorage } from '../../../../../../src/storage/keyvalue/WrappedExpiringStorage';

const cookie = '4c9b88c1-7502-4107-bb79-2a3a590c7aa3';

const ttl = 14 * 24 * 60 * 60 * 1000;
const threshold = 60 * 1000;

const now = new Date();
jest.useFakeTimers();
jest.setSystemTime(now);

describe('A BaseCookieStore', (): void => {
  const accountId = 'id';
  let storage: jest.Mocked<ExpiringStorage<string, string>>;
  let store: BaseCookieStore;

  beforeEach(async(): Promise<void> => {
    jest.setSystemTime(now);
    jest.spyOn(crypto, 'randomUUID').mockReturnValue(cookie);

    // Note that this storage does not expose `getExpiration`
    storage = {
      get: jest.fn().mockResolvedValue(accountId),
      set: jest.fn(),
      delete: jest.fn(),
    } as any;

    store = new BaseCookieStore(storage);
  });

  it('can create new cookies.', async(): Promise<void> => {
    await expect(store.generate(accountId)).resolves.toBe(cookie);
    expect(storage.set).toHaveBeenCalledTimes(1);
    expect(storage.set).toHaveBeenLastCalledWith(cookie, accountId, ttl);
  });

  it('can return the matching account ID.', async(): Promise<void> => {
    await expect(store.get(cookie)).resolves.toBe(accountId);
    expect(storage.get).toHaveBeenCalledTimes(1);
    expect(storage.get).toHaveBeenLastCalledWith(cookie);
  });

  it('can refresh the expiration timer.', async(): Promise<void> => {
    await expect(store.refresh(cookie)).resolves.toEqual(new Date(now.getTime() + ttl));
    expect(storage.get).toHaveBeenCalledTimes(1);
    expect(storage.get).toHaveBeenLastCalledWith(cookie);
    expect(storage.set).toHaveBeenCalledTimes(1);
    expect(storage.set).toHaveBeenLastCalledWith(cookie, accountId, ttl);
  });

  it('reuses a provided account ID to refresh without reading the storage.', async(): Promise<void> => {
    await expect(store.refresh(cookie, 'other-id'))
      .resolves.toEqual(new Date(now.getTime() + ttl));
    // The mapping is not re-read when the account ID is already known.
    expect(storage.get).toHaveBeenCalledTimes(0);
    expect(storage.set).toHaveBeenCalledTimes(1);
    expect(storage.set).toHaveBeenLastCalledWith(cookie, 'other-id', ttl);
  });

  it('does not reset the timer if there is no match.', async(): Promise<void> => {
    storage.get.mockResolvedValueOnce(undefined);
    await expect(store.refresh(cookie)).resolves.toBeUndefined();
    expect(storage.get).toHaveBeenCalledTimes(1);
    expect(storage.get).toHaveBeenLastCalledWith(cookie);
    expect(storage.set).toHaveBeenCalledTimes(0);
  });

  it('persists on every refresh if the storage cannot report the stored expiration.', async(): Promise<void> => {
    await expect(store.refresh(cookie, accountId)).resolves.toEqual(new Date(now.getTime() + ttl));
    await expect(store.refresh(cookie, accountId)).resolves.toEqual(new Date(now.getTime() + ttl));
    expect(storage.set).toHaveBeenCalledTimes(2);
  });

  it('can delete cookies.', async(): Promise<void> => {
    await expect(store.delete(cookie)).resolves.toBeUndefined();
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(storage.delete).toHaveBeenLastCalledWith(cookie);
  });

  describe('with a storage that can report the stored expiration', (): void => {
    let getExpiration: jest.Mock<Promise<Date | undefined>, [string]>;

    beforeEach(async(): Promise<void> => {
      getExpiration = jest.fn();
      storage.getExpiration = getExpiration;
      store = new BaseCookieStore(storage);
    });

    it('skips the write if the expiration would advance by less than the threshold.', async(): Promise<void> => {
      // Last persisted 30 seconds ago, so a fresh expiration only advances it by 30 seconds, below the threshold.
      const stored = new Date(now.getTime() + ttl - (30 * 1000));
      getExpiration.mockResolvedValueOnce(stored);
      const expiration = await store.refresh(cookie, accountId);
      expect(expiration!.toISOString()).toBe(stored.toISOString());
      expect(getExpiration).toHaveBeenCalledTimes(1);
      expect(getExpiration).toHaveBeenLastCalledWith(cookie);
      expect(storage.set).toHaveBeenCalledTimes(0);
    });

    it('skips the write if the expiration would advance by exactly the threshold.', async(): Promise<void> => {
      const stored = new Date(now.getTime() + ttl - threshold);
      getExpiration.mockResolvedValueOnce(stored);
      const expiration = await store.refresh(cookie, accountId);
      expect(expiration!.toISOString()).toBe(stored.toISOString());
      expect(storage.set).toHaveBeenCalledTimes(0);
    });

    it('persists a fresh expiration if the stored one would advance by more than the threshold.', async():
    Promise<void> => {
      const stored = new Date(now.getTime() + ttl - threshold - 1);
      getExpiration.mockResolvedValueOnce(stored);
      await expect(store.refresh(cookie, accountId)).resolves.toEqual(new Date(now.getTime() + ttl));
      expect(storage.set).toHaveBeenCalledTimes(1);
      expect(storage.set).toHaveBeenLastCalledWith(cookie, accountId, ttl);
    });

    it('persists a fresh expiration if the stored one is further in the future.', async(): Promise<void> => {
      // A stored expiration can exceed a fresh one when the configured TTL is reduced.
      const stored = new Date(now.getTime() + ttl + 1000);
      getExpiration.mockResolvedValueOnce(stored);
      await expect(store.refresh(cookie, accountId)).resolves.toEqual(new Date(now.getTime() + ttl));
      expect(storage.set).toHaveBeenCalledTimes(1);
      expect(storage.set).toHaveBeenLastCalledWith(cookie, accountId, ttl);
    });

    it('persists a fresh expiration if there is no stored expiration.', async(): Promise<void> => {
      getExpiration.mockResolvedValueOnce(undefined);
      await expect(store.refresh(cookie, accountId)).resolves.toEqual(new Date(now.getTime() + ttl));
      expect(storage.set).toHaveBeenCalledTimes(1);
      expect(storage.set).toHaveBeenLastCalledWith(cookie, accountId, ttl);
    });

    it('also throttles refreshes that need to look up the account ID.', async(): Promise<void> => {
      const stored = new Date(now.getTime() + ttl - (30 * 1000));
      getExpiration.mockResolvedValueOnce(stored);
      const expiration = await store.refresh(cookie);
      expect(expiration!.toISOString()).toBe(stored.toISOString());
      expect(storage.get).toHaveBeenCalledTimes(1);
      expect(storage.set).toHaveBeenCalledTimes(0);
    });

    it('persists a fresh expiration on every refresh if the threshold is 0.', async(): Promise<void> => {
      store = new BaseCookieStore(storage, 14 * 24 * 60 * 60, 0);
      for (let count = 1; count <= 3; count++) {
        jest.setSystemTime(now.getTime() + (count * 10));
        await expect(store.refresh(cookie, accountId)).resolves.toEqual(new Date(Date.now() + ttl));
        expect(storage.set).toHaveBeenCalledTimes(count);
        expect(storage.set).toHaveBeenLastCalledWith(cookie, accountId, ttl);
      }
      expect(getExpiration).toHaveBeenCalledTimes(0);
    });
  });
});

describe('A BaseCookieStore backed by a WrappedExpiringStorage', (): void => {
  const accountId = 'id';
  let source: MemoryMapStorage<Expires<string>>;
  let setSpy: jest.SpyInstance;
  let store: BaseCookieStore;

  beforeEach(async(): Promise<void> => {
    jest.setSystemTime(now);
    source = new MemoryMapStorage();
    setSpy = jest.spyOn(source, 'set');
    store = new BaseCookieStore(new WrappedExpiringStorage(source));
  });

  afterEach(async(): Promise<void> => {
    jest.clearAllTimers();
  });

  it('keeps an active session alive with few writes and no client/server divergence.', async(): Promise<void> => {
    const start = now.getTime();
    const generated = await store.generate(accountId);

    // Simulate an active "remembered" session: one authenticated request every 10 seconds for 5 minutes.
    for (let count = 1; count <= 30; count++) {
      jest.setSystemTime(start + (count * 10 * 1000));
      const expiration = await store.refresh(generated, accountId);
      const record = await source.get(generated);
      // The expiration sent to the client always matches the stored server-side state exactly.
      expect(expiration!.toISOString()).toBe(record!.expires);
      // The session expires at most `threshold` earlier than an unthrottled refresh allows, and never later.
      const drift = Date.now() + ttl - expiration!.getTime();
      expect(drift).toBeGreaterThanOrEqual(0);
      expect(drift).toBeLessThanOrEqual(threshold);
    }

    // 31 write opportunities (1 generate + 30 refreshes) result in only 5 writes:
    // the initial one and one refresh per elapsed threshold window (70s/140s/210s/280s).
    expect(setSpy).toHaveBeenCalledTimes(5);
  });

  it('still expires a session after sufficient inactivity.', async(): Promise<void> => {
    const start = now.getTime();
    const generated = await store.generate(accountId);

    // Activity until t = 300s, with the last persisted refresh at t = 280s.
    for (let count = 1; count <= 30; count++) {
      jest.setSystemTime(start + (count * 10 * 1000));
      await store.refresh(generated, accountId);
    }

    // The session is still alive just before the stored expiration.
    jest.setSystemTime(start + (280 * 1000) + ttl - 1);
    await expect(store.get(generated)).resolves.toBe(accountId);

    // After 14 days of inactivity the session has expired (stored expiration: 280s + ttl).
    jest.setSystemTime(start + (300 * 1000) + ttl);
    await expect(store.get(generated)).resolves.toBeUndefined();
  });
});
