import type { Quad } from '@rdfjs/types';
import arrayifyStream from 'arrayify-stream';
import { DataFactory } from 'n3';
import { BasicRepresentation } from '../../../src/http/representation/BasicRepresentation';
import type { Representation } from '../../../src/http/representation/Representation';
import { RepresentationMetadata } from '../../../src/http/representation/RepresentationMetadata';
import type { RepresentationPreferences } from '../../../src/http/representation/RepresentationPreferences';
import { CachingResourceStore } from '../../../src/storage/CachingResourceStore';
import type { ResourceStore } from '../../../src/storage/ResourceStore';
import { INTERNAL_QUADS } from '../../../src/util/ContentTypes';
import { IdentifierMap } from '../../../src/util/map/IdentifierMap';
import { SimpleSuffixStrategy } from '../../util/SimpleSuffixStrategy';

function makeQuads(count: number): Quad[] {
  const quads: Quad[] = [];
  for (let i = 0; i < count; i++) {
    quads.push(DataFactory.quad(
      DataFactory.namedNode(`http://example.org/s${i}`),
      DataFactory.namedNode('http://example.org/p'),
      DataFactory.literal(`o${i}`),
    ));
  }
  return quads;
}

async function readQuads(representation: Representation): Promise<Quad[]> {
  return arrayifyStream<Quad>(representation.data);
}

describe('A CachingResourceStore', (): void => {
  const aclId = { path: 'http://example.org/foo/.acl' };
  const subjectId = { path: 'http://example.org/foo/' };
  const dataId = { path: 'http://example.org/foo/data' };
  const aId = { path: 'http://example.org/a/.acl' };
  const bId = { path: 'http://example.org/b/.acl' };
  const cId = { path: 'http://example.org/c/.acl' };
  const quadsPref: RepresentationPreferences = { type: { [INTERNAL_QUADS]: 1 }};

  let quads: Quad[];
  let strategy: SimpleSuffixStrategy;
  let source: jest.Mocked<ResourceStore>;
  let store: CachingResourceStore;

  beforeEach(async(): Promise<void> => {
    quads = makeQuads(2);
    strategy = new SimpleSuffixStrategy('.acl');
    source = {
      getRepresentation: jest.fn(
        async(): Promise<Representation> => new BasicRepresentation([ ...quads ], INTERNAL_QUADS),
      ),
      hasResource: jest.fn(async(): Promise<boolean> => true),
      addResource: jest.fn(async(): Promise<IdentifierMap<RepresentationMetadata>> => new IdentifierMap()),
      setRepresentation: jest.fn(async(): Promise<IdentifierMap<RepresentationMetadata>> => new IdentifierMap()),
      modifyResource: jest.fn(async(): Promise<IdentifierMap<RepresentationMetadata>> => new IdentifierMap()),
      deleteResource: jest.fn(async(): Promise<IdentifierMap<RepresentationMetadata>> => new IdentifierMap()),
    } as any;
    store = new CachingResourceStore(source, strategy);
  });

  afterEach((): void => {
    jest.restoreAllMocks();
  });

  it('passes reads of non-auxiliary resources directly to the source.', async(): Promise<void> => {
    await store.getRepresentation(dataId, quadsPref);
    await store.getRepresentation(dataId, quadsPref);
    expect(source.getRepresentation).toHaveBeenCalledTimes(2);
  });

  it('passes reads with non-quads preferences directly to the source.', async(): Promise<void> => {
    const preferences: RepresentationPreferences = { type: { 'text/turtle': 1 }};
    await store.getRepresentation(aclId, preferences);
    await store.getRepresentation(aclId, preferences);
    expect(source.getRepresentation).toHaveBeenCalledTimes(2);
  });

  it('passes reads with additional preference dimensions directly to the source.', async(): Promise<void> => {
    const preferences: RepresentationPreferences =
      { type: { [INTERNAL_QUADS]: 1 }, range: { unit: 'bytes', parts: [{ start: 0 }]}};
    await store.getRepresentation(aclId, preferences);
    await store.getRepresentation(aclId, preferences);
    expect(source.getRepresentation).toHaveBeenCalledTimes(2);
  });

  it('passes reads whose only preference is not a type directly to the source.', async(): Promise<void> => {
    const preferences: RepresentationPreferences = { range: { unit: 'bytes', parts: [{ start: 0 }]}};
    await store.getRepresentation(aclId, preferences);
    await store.getRepresentation(aclId, preferences);
    expect(source.getRepresentation).toHaveBeenCalledTimes(2);
  });

  it('passes reads with multiple type preferences directly to the source.', async(): Promise<void> => {
    const preferences: RepresentationPreferences = { type: { [INTERNAL_QUADS]: 1, 'text/turtle': 1 }};
    await store.getRepresentation(aclId, preferences);
    await store.getRepresentation(aclId, preferences);
    expect(source.getRepresentation).toHaveBeenCalledTimes(2);
  });

  it('passes conditional reads directly to the source.', async(): Promise<void> => {
    await store.getRepresentation(aclId, quadsPref, {} as any);
    await store.getRepresentation(aclId, quadsPref, {} as any);
    expect(source.getRepresentation).toHaveBeenCalledTimes(2);
  });

  it('caches a matching read and serves the next read without hitting the source.', async(): Promise<void> => {
    const expected = quads.map((q): string => q.subject.value);
    const first = await store.getRepresentation(aclId, quadsPref);
    expect(first.metadata.contentType).toBe(INTERNAL_QUADS);
    expect((await readQuads(first)).map((q): string => q.subject.value)).toEqual(expected);

    const second = await store.getRepresentation(aclId, quadsPref);
    expect(source.getRepresentation).toHaveBeenCalledTimes(1);
    expect((await readQuads(second)).map((q): string => q.subject.value)).toEqual(expected);
    expect(second.metadata.contentType).toBe(INTERNAL_QUADS);
  });

  it('deduplicates concurrent misses on the same key.', async(): Promise<void> => {
    const [ first, second ] = await Promise.all([
      store.getRepresentation(aclId, quadsPref),
      store.getRepresentation(aclId, quadsPref),
    ]);
    expect(source.getRepresentation).toHaveBeenCalledTimes(1);
    await expect(readQuads(first)).resolves.toHaveLength(2);
    await expect(readQuads(second)).resolves.toHaveLength(2);
  });

  it('caches a positive existence result.', async(): Promise<void> => {
    await expect(store.hasResource(aclId)).resolves.toBe(true);
    await expect(store.hasResource(aclId)).resolves.toBe(true);
    expect(source.hasResource).toHaveBeenCalledTimes(1);
  });

  it('caches a negative existence result.', async(): Promise<void> => {
    source.hasResource.mockResolvedValue(false);
    await expect(store.hasResource(aclId)).resolves.toBe(false);
    await expect(store.hasResource(aclId)).resolves.toBe(false);
    expect(source.hasResource).toHaveBeenCalledTimes(1);
  });

  it('passes existence checks of non-auxiliary resources directly to the source.', async(): Promise<void> => {
    await store.hasResource(subjectId);
    await store.hasResource(subjectId);
    expect(source.hasResource).toHaveBeenCalledTimes(2);
  });

  it.each([ 'addResource', 'setRepresentation', 'modifyResource', 'deleteResource' ] as const)(
    'invalidates cached representations and existence results after a %s.',
    async(method): Promise<void> => {
      source[method] = jest.fn(
        async(): Promise<IdentifierMap<RepresentationMetadata>> =>
          new IdentifierMap([[ aclId, new RepresentationMetadata() ]]),
      ) as any;

      await store.getRepresentation(aclId, quadsPref);
      await store.hasResource(aclId);
      expect(source.getRepresentation).toHaveBeenCalledTimes(1);
      expect(source.hasResource).toHaveBeenCalledTimes(1);

      await (store as any)[method](aclId, {});

      await store.getRepresentation(aclId, quadsPref);
      await store.hasResource(aclId);
      expect(source.getRepresentation).toHaveBeenCalledTimes(2);
      expect(source.hasResource).toHaveBeenCalledTimes(2);
    },
  );

  it('invalidates the auxiliary identifier of every changed resource.', async(): Promise<void> => {
    source.setRepresentation.mockResolvedValue(new IdentifierMap([[ subjectId, new RepresentationMetadata() ]]));

    await store.getRepresentation(aclId, quadsPref);
    expect(source.getRepresentation).toHaveBeenCalledTimes(1);

    // The ChangeMap only contains the subject; its auxiliary identifier is aclId, which must be dropped.
    await store.setRepresentation(subjectId, {} as Representation);

    await store.getRepresentation(aclId, quadsPref);
    expect(source.getRepresentation).toHaveBeenCalledTimes(2);
  });

  it(
    'does not store a representation when a write invalidates the key while the read is in flight.',
    async(): Promise<void> => {
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve): void => {
        release = resolve;
      });
      source.getRepresentation
        .mockImplementationOnce(async(): Promise<Representation> => {
          await gate;
          return new BasicRepresentation([ ...quads ], INTERNAL_QUADS);
        })
        .mockImplementation(async(): Promise<Representation> => new BasicRepresentation([ ...quads ], INTERNAL_QUADS));
      source.setRepresentation.mockResolvedValue(new IdentifierMap([[ aclId, new RepresentationMetadata() ]]));

      const readPromise = store.getRepresentation(aclId, quadsPref);
      // A write lands (and invalidates) while the read is still awaiting the source.
      await store.setRepresentation(aclId, {} as Representation);
      release!();
      await readPromise;

      // The raced value was not stored, so the next read hits the source again.
      await store.getRepresentation(aclId, quadsPref);
      expect(source.getRepresentation).toHaveBeenCalledTimes(2);
    },
  );

  it(
    'does not store an existence result when a write invalidates the key while the check is in flight.',
    async(): Promise<void> => {
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve): void => {
        release = resolve;
      });
      source.hasResource
        .mockImplementationOnce(async(): Promise<boolean> => {
          await gate;
          return true;
        })
        .mockImplementation(async(): Promise<boolean> => true);
      source.deleteResource.mockResolvedValue(new IdentifierMap([[ aclId, new RepresentationMetadata() ]]));

      const hasPromise = store.hasResource(aclId);
      await store.deleteResource(aclId);
      release!();
      await hasPromise;

      await store.hasResource(aclId);
      expect(source.hasResource).toHaveBeenCalledTimes(2);
    },
  );

  it('serves but does not store documents larger than the per-document quad limit.', async(): Promise<void> => {
    store = new CachingResourceStore(source, strategy, { maxQuadsPerDoc: 1 });
    const first = await store.getRepresentation(aclId, quadsPref);
    await expect(readQuads(first)).resolves.toHaveLength(2);
    await store.getRepresentation(aclId, quadsPref);
    expect(source.getRepresentation).toHaveBeenCalledTimes(2);
  });

  it('refetches a representation after its ttl expires.', async(): Promise<void> => {
    const now = 1_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    await store.getRepresentation(aclId, quadsPref);
    expect(source.getRepresentation).toHaveBeenCalledTimes(1);

    nowSpy.mockReturnValue(now + 30_001);
    await store.getRepresentation(aclId, quadsPref);
    expect(source.getRepresentation).toHaveBeenCalledTimes(2);
  });

  it('refetches an existence result after its ttl expires.', async(): Promise<void> => {
    const now = 1_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    await store.hasResource(aclId);
    expect(source.hasResource).toHaveBeenCalledTimes(1);

    nowSpy.mockReturnValue(now + 30_001);
    await store.hasResource(aclId);
    expect(source.hasResource).toHaveBeenCalledTimes(2);
  });

  it('disables all caching and invalidation when ttl is 0.', async(): Promise<void> => {
    store = new CachingResourceStore(source, strategy, { ttl: 0 });
    source.addResource.mockResolvedValue(new IdentifierMap([[ aclId, new RepresentationMetadata() ]]));

    await store.getRepresentation(aclId, quadsPref);
    await store.getRepresentation(aclId, quadsPref);
    expect(source.getRepresentation).toHaveBeenCalledTimes(2);

    await store.hasResource(aclId);
    await store.hasResource(aclId);
    expect(source.hasResource).toHaveBeenCalledTimes(2);

    const changes = await store.addResource(subjectId, {} as Representation);
    expect(changes.size).toBe(1);
  });

  it('evicts the least-recently-used representation when maxEntries is exceeded.', async(): Promise<void> => {
    store = new CachingResourceStore(source, strategy, { maxEntries: 2 });
    await store.getRepresentation(aId, quadsPref);
    await store.getRepresentation(bId, quadsPref);
    // Touch A so it becomes most-recently-used; B is now the least-recently-used.
    await store.getRepresentation(aId, quadsPref);
    // Caching C evicts the least-recently-used entry, which is B (not A).
    await store.getRepresentation(cId, quadsPref);
    expect(source.getRepresentation).toHaveBeenCalledTimes(3);

    // A survived the eviction (re-inserted on the earlier hit), so this is served from cache.
    await store.getRepresentation(aId, quadsPref);
    expect(source.getRepresentation).toHaveBeenCalledTimes(3);

    // B was the evicted entry, so it must be refetched.
    await store.getRepresentation(bId, quadsPref);
    expect(source.getRepresentation).toHaveBeenCalledTimes(4);
  });

  it('evicts entries when the total quad limit is exceeded.', async(): Promise<void> => {
    store = new CachingResourceStore(source, strategy, { maxQuads: 3 });
    await store.getRepresentation(aId, quadsPref);
    // Caching B pushes the total to 4 quads, evicting A.
    await store.getRepresentation(bId, quadsPref);
    await store.getRepresentation(aId, quadsPref);
    expect(source.getRepresentation).toHaveBeenCalledTimes(3);
  });

  it('evicts the least-recently-used existence result when maxHasEntries is exceeded.', async(): Promise<void> => {
    store = new CachingResourceStore(source, strategy, { maxHasEntries: 1 });
    await store.hasResource(aId);
    await store.hasResource(bId);
    await store.hasResource(aId);
    expect(source.hasResource).toHaveBeenCalledTimes(3);
  });
});
