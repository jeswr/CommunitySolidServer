import type { ResourceIdentifier } from '../../../src/http/representation/ResourceIdentifier';
import { CachedResourceSet } from '../../../src/storage/CachedResourceSet';
import type { ResourceSet } from '../../../src/storage/ResourceSet';

describe('A CachedResourceSet', (): void => {
  const identifier: ResourceIdentifier = { path: 'http://example.com/foo' };
  let source: jest.Mocked<ResourceSet>;
  let set: CachedResourceSet;

  beforeEach(async(): Promise<void> => {
    source = {
      hasResource: jest.fn().mockResolvedValue(true),
    };

    set = new CachedResourceSet(source);
  });

  it('calls the source.', async(): Promise<void> => {
    await expect(set.hasResource(identifier)).resolves.toBe(true);
    expect(source.hasResource).toHaveBeenCalledTimes(1);
    expect(source.hasResource).toHaveBeenLastCalledWith(identifier, undefined);
  });

  it('caches the result.', async(): Promise<void> => {
    await expect(set.hasResource(identifier)).resolves.toBe(true);
    await expect(set.hasResource(identifier)).resolves.toBe(true);
    expect(source.hasResource).toHaveBeenCalledTimes(1);
    expect(source.hasResource).toHaveBeenLastCalledWith(identifier, undefined);
  });

  it('caches on the identifier object itself.', async(): Promise<void> => {
    const copy = { ...identifier };
    await expect(set.hasResource(identifier)).resolves.toBe(true);
    await expect(set.hasResource(copy)).resolves.toBe(true);
    expect(source.hasResource).toHaveBeenCalledTimes(2);
    expect(source.hasResource).toHaveBeenNthCalledWith(1, identifier, undefined);
    expect(source.hasResource).toHaveBeenNthCalledWith(2, copy, undefined);
  });

  it('forwards storage hints on a cache miss.', async(): Promise<void> => {
    const hints = { contentType: { candidates: [ 'application/json' ], exhaustive: false }};

    await expect(set.hasResource(identifier, hints)).resolves.toBe(true);

    expect(source.hasResource).toHaveBeenCalledWith(identifier, hints);
  });
});
