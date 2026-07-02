import type { KeyValueStorage } from '../../../../src/storage/keyvalue/KeyValueStorage';
import { PassthroughKeyValueStorage } from '../../../../src/storage/keyvalue/PassthroughKeyValueStorage';

class DummyStorage extends PassthroughKeyValueStorage<string> {
  public constructor(source: KeyValueStorage<string, string>) {
    super(source);
  }

  protected toNewKey(key: string): string {
    return `dummy-${key}`;
  }

  protected toOriginalKey(key: string): string {
    return key.slice('dummy-'.length);
  }
}

describe('A PassthroughKeyValueStorage', (): void => {
  let source: jest.Mocked<KeyValueStorage<string, string>>;
  let storage: DummyStorage;

  beforeEach(async(): Promise<void> => {
    source = {
      has: jest.fn(),
      get: jest.fn(),
      set: jest.fn(),
      delete: jest.fn(),
      entries: jest.fn(),
    };

    storage = new DummyStorage(source);
  });

  it('calls the source storage with the updated key.', async(): Promise<void> => {
    await storage.has('key');
    expect(source.has).toHaveBeenCalledTimes(1);
    expect(source.has).toHaveBeenLastCalledWith('dummy-key');

    await storage.get('key');
    expect(source.get).toHaveBeenCalledTimes(1);
    expect(source.get).toHaveBeenLastCalledWith('dummy-key');

    await storage.set('key', 'data');
    expect(source.set).toHaveBeenCalledTimes(1);
    expect(source.set).toHaveBeenLastCalledWith('dummy-key', 'data');

    await storage.delete('key');
    expect(source.delete).toHaveBeenCalledTimes(1);
    expect(source.delete).toHaveBeenLastCalledWith('dummy-key');

    // Set up data to test entries call
    const map = new Map<string, string>([[ 'dummy-key', 'value' ], [ 'dummy-key2', 'value2' ]]);
    source.entries.mockReturnValue(map.entries() as unknown as AsyncIterableIterator<[string, string]>);
    const results = [];
    for await (const entry of storage.entries()) {
      results.push(entry);
    }
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual([ 'key', 'value' ]);
    expect(results[1]).toEqual([ 'key2', 'value2' ]);
  });

  it('does not forward the prefix to the source and filters the transformed keys.', async(): Promise<void> => {
    const map = new Map<string, string>([[ 'dummy-key', 'value' ], [ 'dummy-other', 'value2' ]]);
    source.entries.mockReturnValue(map.entries() as unknown as AsyncIterableIterator<[string, string]>);
    const results = [];
    for await (const entry of storage.entries('ke')) {
      results.push(entry);
    }
    expect(source.entries).toHaveBeenCalledTimes(1);
    expect(source.entries).toHaveBeenLastCalledWith();
    expect(results).toEqual([[ 'key', 'value' ]]);
  });
});
