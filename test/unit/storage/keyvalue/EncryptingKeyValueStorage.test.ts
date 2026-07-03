import { EncryptingKeyValueStorage } from '../../../../src/storage/keyvalue/EncryptingKeyValueStorage';
import type { KeyValueStorage } from '../../../../src/storage/keyvalue/KeyValueStorage';

describe('An EncryptingKeyValueStorage', (): void => {
  const secret = 'test-secret-passphrase';
  let originalEnv: string | undefined;
  let map: Map<string, unknown>;
  let source: KeyValueStorage<string, unknown>;
  let storage: EncryptingKeyValueStorage<unknown>;

  beforeEach((): void => {
    // Make sure the environment does not leak into the key resolution of these tests.
    originalEnv = process.env.CSS_STORAGE_ENCRYPTION_KEY;
    delete process.env.CSS_STORAGE_ENCRYPTION_KEY;

    map = new Map<string, unknown>();
    source = map as unknown as KeyValueStorage<string, unknown>;
    storage = new EncryptingKeyValueStorage(source, secret);
  });

  afterEach((): void => {
    if (typeof originalEnv === 'string') {
      process.env.CSS_STORAGE_ENCRYPTION_KEY = originalEnv;
    } else {
      delete process.env.CSS_STORAGE_ENCRYPTION_KEY;
    }
  });

  it('stores values encrypted and decrypts them on read.', async(): Promise<void> => {
    const value = { keys: [{ kty: 'EC', d: 'super-secret-private-key' }]};
    await storage.set('jwks', value);

    // On disk the value is an encryption envelope, not the plaintext.
    const stored = map.get('jwks') as Record<string, unknown>;
    expect(stored.encrypted).toBe(true);
    expect(typeof stored.iv).toBe('string');
    expect(typeof stored.tag).toBe('string');
    expect(typeof stored.value).toBe('string');
    expect(JSON.stringify(stored)).not.toContain('super-secret-private-key');

    // Reading transparently decrypts back to the original value.
    await expect(storage.get('jwks')).resolves.toEqual(value);
  });

  it('uses a random IV so identical values encrypt differently.', async(): Promise<void> => {
    await storage.set('a', { v: 1 });
    const first = map.get('a') as Record<string, unknown>;
    await storage.set('a', { v: 1 });
    const second = map.get('a') as Record<string, unknown>;
    expect(first.iv).not.toBe(second.iv);
    expect(first.value).not.toBe(second.value);
  });

  it('returns undefined for a missing key.', async(): Promise<void> => {
    await expect(storage.get('missing')).resolves.toBeUndefined();
  });

  it('returns a legacy plaintext object value unchanged.', async(): Promise<void> => {
    // A value written by the source directly, before encryption was enabled.
    const legacy = { keys: [{ kty: 'EC' }]};
    map.set('jwks', legacy);
    await expect(storage.get('jwks')).resolves.toBe(legacy);
  });

  it('returns a legacy plaintext primitive value unchanged.', async(): Promise<void> => {
    map.set('flag', 'initialized');
    await expect(storage.get('flag')).resolves.toBe('initialized');
  });

  it('returns a legacy null value unchanged.', async(): Promise<void> => {
    map.set('empty', null);
    await expect(storage.get('empty')).resolves.toBeNull();
  });

  it('decrypts values and passes legacy values through when iterating entries.', async(): Promise<void> => {
    await storage.set('a', { v: 1 });
    await storage.set('b', { v: 2 });
    // A legacy plaintext entry.
    map.set('legacy', { plain: true });

    const results = [];
    for await (const entry of storage.entries()) {
      results.push(entry);
    }
    expect(results).toHaveLength(3);
    expect(results).toContainEqual([ 'a', { v: 1 }]);
    expect(results).toContainEqual([ 'b', { v: 2 }]);
    expect(results).toContainEqual([ 'legacy', { plain: true }]);
  });

  it('passes has and delete straight through to the source.', async(): Promise<void> => {
    const mocked: jest.Mocked<KeyValueStorage<string, unknown>> = {
      has: jest.fn().mockResolvedValue(true),
      get: jest.fn(),
      set: jest.fn(),
      delete: jest.fn().mockResolvedValue(true),
      entries: jest.fn(),
    };
    const wrapper = new EncryptingKeyValueStorage(mocked, secret);

    await expect(wrapper.has('key')).resolves.toBe(true);
    expect(mocked.has).toHaveBeenCalledTimes(1);
    expect(mocked.has).toHaveBeenLastCalledWith('key');

    await expect(wrapper.delete('key')).resolves.toBe(true);
    expect(mocked.delete).toHaveBeenCalledTimes(1);
    expect(mocked.delete).toHaveBeenLastCalledWith('key');
  });

  it('returns itself after a set so calls can be chained.', async(): Promise<void> => {
    await expect(storage.set('key', { v: 1 })).resolves.toBe(storage);
  });

  it('throws a clear error when decrypting with the wrong key.', async(): Promise<void> => {
    await storage.set('key', { v: 1 });
    const other = new EncryptingKeyValueStorage(source, 'a-different-secret');
    await expect(other.get('key')).rejects.toThrow('Unable to decrypt a stored value');
  });

  it('throws a clear error when the ciphertext has been tampered with.', async(): Promise<void> => {
    await storage.set('key', { v: 1 });
    const stored = map.get('key') as Record<string, unknown>;
    stored.value = Buffer.from('tampered-ciphertext').toString('base64');
    await expect(storage.get('key')).rejects.toThrow('Unable to decrypt a stored value');
  });

  describe('without an available key', (): void => {
    it('throws when neither a key argument nor the environment variable is set.', (): void => {
      expect((): EncryptingKeyValueStorage<unknown> => new EncryptingKeyValueStorage(source))
        .toThrow('no encryption key was provided');
    });

    it('throws when the provided key is an empty string.', (): void => {
      expect((): EncryptingKeyValueStorage<unknown> => new EncryptingKeyValueStorage(source, ''))
        .toThrow('no encryption key was provided');
    });

    it('derives the key from the CSS_STORAGE_ENCRYPTION_KEY environment variable.', async(): Promise<void> => {
      process.env.CSS_STORAGE_ENCRYPTION_KEY = 'environment-secret';
      const envStorage = new EncryptingKeyValueStorage(source);
      await envStorage.set('key', { v: 1 });
      await expect(envStorage.get('key')).resolves.toEqual({ v: 1 });
    });
  });
});
