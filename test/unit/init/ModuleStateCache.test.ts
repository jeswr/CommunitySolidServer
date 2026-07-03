import { promises as fsPromises } from 'node:fs';
import type { IModuleState } from 'componentsjs';
import { readJson } from 'fs-extra';
import { ModuleStateCache } from '../../../src/init/ModuleStateCache';
import type { Logger } from '../../../src/logging/Logger';
import { getLoggerFor } from '../../../src/logging/LogUtil';

let files: Record<string, string>;

jest.mock('node:fs', (): any => ({
  promises: {
    readFile: jest.fn(async(path: string): Promise<string> => {
      if (typeof files[path] === 'string') {
        return files[path];
      }
      throw new Error(`File not found: ${path}`);
    }),
    writeFile: jest.fn(async(path: string, data: string): Promise<void> => {
      files[path] = data;
    }),
    rename: jest.fn(async(source: string, destination: string): Promise<void> => {
      files[destination] = files[source];
      delete files[source];
    }),
    unlink: jest.fn(async(path: string): Promise<void> => {
      delete files[path];
    }),
  },
}));

jest.mock('fs-extra', (): any => ({
  readJson: jest.fn(async(): Promise<unknown> => ({ version: '7.1.0' })),
}));

jest.mock('../../../src/logging/LogUtil', (): any => {
  const logger: Logger = { debug: jest.fn(), warn: jest.fn() } as any;
  return { getLoggerFor: (): Logger => logger };
});

describe('A ModuleStateCache', (): void => {
  const logger: jest.Mocked<Logger> = getLoggerFor(ModuleStateCache) as any;
  const cachePath = '/data/module-state.json';
  const mainModulePath = '/data';
  const moduleState = { mainModulePath } as unknown as IModuleState;
  let cache: ModuleStateCache;

  beforeEach((): void => {
    files = {
      '/data/package-lock.json': '{ "lockfileVersion": 3 }',
      '/data/package.json': '{ "name": "test" }',
    };

    cache = new ModuleStateCache(cachePath, mainModulePath);
  });

  afterEach((): void => {
    jest.clearAllMocks();
  });

  it('stores the module state together with the key.', async(): Promise<void> => {
    await expect(cache.save(moduleState)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(0);
    // No temporary file (neither the legacy nor a unique name) remains after saving.
    expect(Object.keys(files).some((path): boolean => path.endsWith('.tmp'))).toBe(false);
    expect(JSON.parse(files[cachePath])).toEqual({ key: expect.any(String), moduleState });
  });

  it('returns the module state if the stored key matches.', async(): Promise<void> => {
    await cache.save(moduleState);
    // Reset the mocks so only the behaviour of load() is asserted below.
    jest.clearAllMocks();
    // Use a new instance to make sure the key is not being reused from memory
    cache = new ModuleStateCache(cachePath, mainModulePath);
    await expect(cache.load()).resolves.toEqual(moduleState);
    expect(fsPromises.unlink).toHaveBeenCalledTimes(0);
    expect(logger.warn).toHaveBeenCalledTimes(0);
  });

  it('only computes the key once.', async(): Promise<void> => {
    await cache.save(moduleState);
    await cache.save(moduleState);
    expect(readJson).toHaveBeenCalledTimes(1);
    await expect(cache.load()).resolves.toEqual(moduleState);
    expect(readJson).toHaveBeenCalledTimes(1);
  });

  it('returns undefined if there is no cache file.', async(): Promise<void> => {
    await expect(cache.load()).resolves.toBeUndefined();
    expect(fsPromises.unlink).toHaveBeenCalledTimes(0);
    expect(logger.warn).toHaveBeenCalledTimes(0);
  });

  it('removes the cache file if it does not contain valid JSON.', async(): Promise<void> => {
    files[cachePath] = 'invalid json';
    await expect(cache.load()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(fsPromises.unlink).toHaveBeenCalledTimes(1);
    expect(files[cachePath]).toBeUndefined();
  });

  it('removes the cache file if it does not contain an object.', async(): Promise<void> => {
    files[cachePath] = 'null';
    await expect(cache.load()).resolves.toBeUndefined();
    expect(fsPromises.unlink).toHaveBeenCalledTimes(1);
    expect(files[cachePath]).toBeUndefined();
  });

  it('removes the cache file if the stored key does not match.', async(): Promise<void> => {
    files[cachePath] = JSON.stringify({ key: 'wrong', moduleState });
    await expect(cache.load()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(0);
    expect(fsPromises.unlink).toHaveBeenCalledTimes(1);
    expect(files[cachePath]).toBeUndefined();
  });

  it('ignores the cache without removing it if the key could not be computed.', async(): Promise<void> => {
    const entry = JSON.stringify({ key: 'irrelevant', moduleState });
    files[cachePath] = entry;
    jest.mocked(readJson).mockRejectedValueOnce(new Error('bad package.json'));
    await expect(cache.load()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    // A transient key-computation error must not invalidate a potentially valid cache entry.
    expect(fsPromises.unlink).toHaveBeenCalledTimes(0);
    expect(files[cachePath]).toBe(entry);
  });

  it('generates a different key if there is no package-lock.json.', async(): Promise<void> => {
    await cache.save(moduleState);
    const lockKey = (JSON.parse(files[cachePath]) as { key: string }).key;

    delete files['/data/package-lock.json'];
    cache = new ModuleStateCache(cachePath, mainModulePath);
    await cache.save(moduleState);
    const packageKey = (JSON.parse(files[cachePath]) as { key: string }).key;
    expect(packageKey).not.toBe(lockKey);

    // The cache remains valid as long as the package.json does not change
    cache = new ModuleStateCache(cachePath, mainModulePath);
    await expect(cache.load()).resolves.toEqual(moduleState);
  });

  it('writes to a unique temporary file that includes the process id.', async(): Promise<void> => {
    await cache.save(moduleState);
    const firstTemp = jest.mocked(fsPromises.writeFile).mock.calls[0][0] as string;
    await cache.save(moduleState);
    const secondTemp = jest.mocked(fsPromises.writeFile).mock.calls[1][0] as string;

    // The temporary name is unique per process and per call, unlike the fixed `${path}.tmp`.
    expect(firstTemp).toContain(`.${process.pid}.`);
    expect(firstTemp).not.toBe(`${cachePath}.tmp`);
    expect(firstTemp).not.toBe(secondTemp);
    // No temporary files are left behind after saving.
    expect(Object.keys(files).some((path): boolean => path.endsWith('.tmp'))).toBe(false);
  });

  it('removes the existing cache file before renaming for cross-platform overwrite.', async(): Promise<void> => {
    files[cachePath] = 'stale';
    const order: string[] = [];
    jest.mocked(fsPromises.unlink).mockImplementationOnce(async(path: string): Promise<void> => {
      order.push(`unlink:${path}`);
      delete files[path];
    });
    jest.mocked(fsPromises.rename).mockImplementationOnce(async(source: string, destination: string): Promise<void> => {
      order.push(`rename:${destination}`);
      files[destination] = files[source];
      delete files[source];
    });

    await expect(cache.save(moduleState)).resolves.toBeUndefined();
    // The destination gets removed first so the rename works even where it does not overwrite.
    expect(order).toEqual([ `unlink:${cachePath}`, `rename:${cachePath}` ]);
    expect(JSON.parse(files[cachePath])).toEqual({ key: expect.any(String), moduleState });
  });

  it('cleans up the temporary file if renaming fails.', async(): Promise<void> => {
    jest.mocked(fsPromises.rename).mockRejectedValueOnce(new Error('rename failed'));
    await expect(cache.save(moduleState)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    // The unique temporary file must not be left behind when the write does not complete.
    const tempPath = jest.mocked(fsPromises.writeFile).mock.calls[0][0] as string;
    expect(files[tempPath]).toBeUndefined();
  });

  it('logs a warning if the module state could not be written.', async(): Promise<void> => {
    jest.mocked(fsPromises.writeFile).mockRejectedValueOnce(new Error('disk full'));
    await expect(cache.save(moduleState)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(files[cachePath]).toBeUndefined();
  });

  it('logs a warning if no dependencies file could be read while saving.', async(): Promise<void> => {
    delete files['/data/package-lock.json'];
    delete files['/data/package.json'];
    await expect(cache.save(moduleState)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(fsPromises.writeFile).toHaveBeenCalledTimes(0);
  });

  it('ignores errors when removing the cache file.', async(): Promise<void> => {
    files[cachePath] = 'invalid json';
    jest.mocked(fsPromises.unlink).mockRejectedValueOnce(new Error('file is locked'));
    await expect(cache.load()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
