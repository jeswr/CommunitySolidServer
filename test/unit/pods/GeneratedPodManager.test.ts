import arrayifyStream from 'arrayify-stream';
import { DataFactory } from 'n3';
import type { AuxiliaryIdentifierStrategy } from '../../../src/http/auxiliary/AuxiliaryIdentifierStrategy';
import { BasicRepresentation } from '../../../src/http/representation/BasicRepresentation';
import type { Representation } from '../../../src/http/representation/Representation';
import type { ResourceIdentifier } from '../../../src/http/representation/ResourceIdentifier';
import type { Resource, ResourcesGenerator } from '../../../src/pods/generate/ResourcesGenerator';
import { GeneratedPodManager } from '../../../src/pods/GeneratedPodManager';
import type { PodSettings } from '../../../src/pods/settings/PodSettings';
import type { ResourceStore } from '../../../src/storage/ResourceStore';
import { INTERNAL_QUADS } from '../../../src/util/ContentTypes';
import { ConflictHttpError } from '../../../src/util/errors/ConflictHttpError';
import { MethodNotAllowedHttpError } from '../../../src/util/errors/MethodNotAllowedHttpError';
import { LDP, PIM, RDF } from '../../../src/util/Vocabularies';

const { namedNode, quad } = DataFactory;

describe('A GeneratedPodManager', (): void => {
  const base = 'http://example.com/';
  let settings: PodSettings;
  let store: jest.Mocked<ResourceStore>;
  let generatorData: Resource[];
  let resGenerator: ResourcesGenerator;
  const metadataStrategy: AuxiliaryIdentifierStrategy = {
    getAuxiliaryIdentifier: ({ path }: ResourceIdentifier): ResourceIdentifier => ({ path: `${path}.meta` }),
  } as any;
  let manager: GeneratedPodManager;

  beforeEach(async(): Promise<void> => {
    settings = {
      name: 'first last',
      webId: 'http://secure/webId',
      base: { path: 'http://example.com/user/' },
    };
    store = {
      setRepresentation: jest.fn(),
      hasResource: jest.fn(),
      deleteResource: jest.fn(),
      getRepresentation: jest.fn(),
    } as any;
    generatorData = [
      { identifier: { path: '/path/' }, representation: '/' as any },
      { identifier: { path: '/path/a/' }, representation: '/a/' as any },
      { identifier: { path: '/path/a/b' }, representation: '/a/b' as any },
    ];
    resGenerator = {
      generate: jest.fn(async function* (): any {
        yield* generatorData;
      }),
    };
    manager = new GeneratedPodManager(store, resGenerator, metadataStrategy, base);
  });

  it('throws an error if the generate identifier is not available.', async(): Promise<void> => {
    store.hasResource.mockResolvedValueOnce(true);
    const result = manager.createPod(settings, false);
    await expect(result).rejects.toThrow(`There already is a resource at ${base}user/`);
    await expect(result).rejects.toThrow(ConflictHttpError);
  });

  it('generates an identifier and writes containers before writing the resources in them.', async(): Promise<void> => {
    await expect(manager.createPod(settings, false)).resolves.toBeUndefined();

    expect(store.setRepresentation).toHaveBeenCalledTimes(3);
    expect(store.setRepresentation).toHaveBeenNthCalledWith(1, { path: '/path/' }, '/');
    expect(store.setRepresentation).toHaveBeenNthCalledWith(2, { path: '/path/a/' }, '/a/');
    expect(store.setRepresentation).toHaveBeenNthCalledWith(3, { path: '/path/a/b' }, '/a/b');
  });

  it('allows overwriting when enabled.', async(): Promise<void> => {
    store.hasResource.mockResolvedValueOnce(true);
    await expect(manager.createPod(settings, true)).resolves.toBeUndefined();

    expect(store.setRepresentation).toHaveBeenCalledTimes(3);
    expect(store.setRepresentation).toHaveBeenNthCalledWith(1, { path: '/path/' }, '/');
    expect(store.setRepresentation).toHaveBeenNthCalledWith(2, { path: '/path/a/' }, '/a/');
    expect(store.setRepresentation).toHaveBeenNthCalledWith(3, { path: '/path/a/b' }, '/a/b');
  });

  describe('deleting a pod', (): void => {
    const pod = `${base}user/`;
    // Container contents, a nested storage is used to test that it is not deleted
    let containers: Record<string, string[]>;
    let storages: string[];

    beforeEach(async(): Promise<void> => {
      containers = {
        [pod]: [ `${pod}a/`, `${pod}b` ],
        [`${pod}a/`]: [ `${pod}a/c` ],
      };
      storages = [ pod ];

      store.hasResource.mockResolvedValue(true);
      store.getRepresentation.mockImplementation(async({ path }: ResourceIdentifier): Promise<Representation> => {
        const quads = (containers[path] ?? []).map((child): any =>
          quad(namedNode(path), LDP.terms.contains, namedNode(child)));
        // Unrelated triple that should be ignored
        quads.push(quad(namedNode(`${path}other`), LDP.terms.contains, namedNode(`${path}nope`)));
        const representation = new BasicRepresentation(quads, { path }, INTERNAL_QUADS);
        if (storages.includes(path)) {
          representation.metadata.add(RDF.terms.type, PIM.terms.Storage);
        }
        return representation;
      });
    });

    it('deletes all resources depth-first and clears the root storage marker.', async(): Promise<void> => {
      await expect(manager.deletePod({ path: pod })).resolves.toBeUndefined();

      expect(store.getRepresentation).toHaveBeenCalledWith({ path: pod }, { type: { [INTERNAL_QUADS]: 1 }});
      expect(store.deleteResource.mock.calls.map((call): string => call[0].path))
        .toEqual([ `${pod}a/c`, `${pod}a/`, `${pod}b`, pod ]);

      expect(store.setRepresentation).toHaveBeenCalledTimes(1);
      const [ identifier, representation ] = store.setRepresentation.mock.calls[0];
      expect(identifier).toEqual({ path: `${pod}.meta` });
      expect(representation.metadata.contentType).toBe(INTERNAL_QUADS);
      await expect(arrayifyStream(representation.data)).resolves.toEqual([]);
      expect(store.setRepresentation.mock.invocationCallOrder[0])
        .toBeLessThan(store.deleteResource.mock.invocationCallOrder[3]);
    });

    it('does not delete anything if the pod contains another storage.', async(): Promise<void> => {
      storages.push(`${pod}a/`);
      await expect(manager.deletePod({ path: pod })).rejects.toThrow(ConflictHttpError);
      expect(store.deleteResource).toHaveBeenCalledTimes(0);
      expect(store.setRepresentation).toHaveBeenCalledTimes(0);
    });

    it('does nothing if the pod does not exist.', async(): Promise<void> => {
      store.hasResource.mockResolvedValueOnce(false);
      await expect(manager.deletePod({ path: pod })).resolves.toBeUndefined();
      expect(store.deleteResource).toHaveBeenCalledTimes(0);
    });

    it('can not delete a pod at the root of the server.', async(): Promise<void> => {
      await expect(manager.deletePod({ path: base })).rejects.toThrow(MethodNotAllowedHttpError);
      expect(store.deleteResource).toHaveBeenCalledTimes(0);
    });
  });
});
