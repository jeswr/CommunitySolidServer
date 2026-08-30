import 'jest-rdf';
import type { Readable } from 'node:stream';
import { RepresentationMetadata } from '../../../../src/http/representation/RepresentationMetadata';
import { AtomicFileDataAccessor } from '../../../../src/storage/accessors/AtomicFileDataAccessor';
import { ExtensionBasedMapper } from '../../../../src/storage/mapping/ExtensionBasedMapper';
import type { FileIdentifierMapper } from '../../../../src/storage/mapping/FileIdentifierMapper';
import { APPLICATION_OCTET_STREAM } from '../../../../src/util/ContentTypes';
import type { Guarded } from '../../../../src/util/GuardedStream';
import { guardedStreamFrom } from '../../../../src/util/StreamUtil';
import { CONTENT_TYPE } from '../../../../src/util/Vocabularies';
import { mockFileSystem } from '../../../util/Util';

jest.mock('node:fs');
jest.mock('fs-extra');

describe('AtomicFileDataAccessor', (): void => {
  const rootFilePath = 'uploads';
  const base = 'http://test.com/';
  let accessor: AtomicFileDataAccessor;
  let mapper: FileIdentifierMapper;
  let cache: { data: any };
  let metadata: RepresentationMetadata;
  let data: Guarded<Readable>;

  beforeEach(async(): Promise<void> => {
    cache = mockFileSystem(rootFilePath, new Date());
    mapper = new ExtensionBasedMapper(base, rootFilePath);
    accessor = new AtomicFileDataAccessor(
      mapper,
      rootFilePath,
      './.internal/tempFiles/',
    );
    // The 'mkdirSync' in AtomicFileDataAccessor's constructor does not seem to create the folder in the
    // cache object used for mocking fs.
    // This line creates what represents a folder in the cache object
    cache.data['.internal'] = { tempFiles: {}};
    metadata = new RepresentationMetadata(APPLICATION_OCTET_STREAM);
    data = guardedStreamFrom([ 'data' ]);
  });

  describe('writing a document', (): void => {
    it('writes the data to the corresponding file.', async(): Promise<void> => {
      await expect(accessor.writeDocument({ path: `${base}resource` }, data, metadata)).resolves.toBeUndefined();
      expect(cache.data.resource).toBe('data');
    });

    it('skips existing-extension discovery with exhaustive candidates.', async(): Promise<void> => {
      const identifier = { path: `${base}resource` };
      metadata.contentType = 'application/json';
      const mapSpy = jest.spyOn(mapper, 'mapUrlToFilePath');
      const readdirSpy = jest.spyOn(jest.requireMock('node:fs').promises, 'readdir');

      await accessor.writeDocument(identifier, data, metadata, {
        existingStorageHints: {
          contentType: { candidates: [ 'application/json' ], exhaustive: true },
        },
      });

      expect(cache.data['resource$.json']).toBe('data');
      expect(mapSpy).not.toHaveBeenCalledWith(identifier, false);
      expect(readdirSpy).not.toHaveBeenCalled();
    });

    it('uses an exhaustive candidate when replacing a document.', async(): Promise<void> => {
      const identifier = { path: `${base}resource` };
      cache.data['resource$.ttl'] = 'old data';
      metadata.contentType = 'application/json';
      const mapSpy = jest.spyOn(mapper, 'mapUrlToFilePath');

      await accessor.writeDocument(identifier, data, metadata, {
        existingStorageHints: {
          contentType: { candidates: [ 'text/turtle' ], exhaustive: true },
        },
      });

      expect(cache.data['resource$.ttl']).toBeUndefined();
      expect(cache.data['resource$.json']).toBe('data');
      expect(mapSpy).toHaveBeenCalledWith(identifier, false, 'text/turtle');
    });

    it('discovers an existing document after an advisory candidate misses.', async(): Promise<void> => {
      const identifier = { path: `${base}resource` };
      cache.data['resource$.ttl'] = 'old data';
      metadata.contentType = 'application/json';

      await accessor.writeDocument(identifier, data, metadata, {
        existingStorageHints: {
          contentType: { candidates: [ 'application/json' ], exhaustive: false },
        },
      });

      expect(cache.data['resource$.ttl']).toBeUndefined();
      expect(cache.data['resource$.json']).toBe('data');
    });

    it('removes the temporary file when existing-resource lookup fails.', async(): Promise<void> => {
      const identifier = { path: `${base}resource` };
      metadata.contentType = 'application/json';
      jest.spyOn(jest.requireMock('fs-extra'), 'lstat').mockRejectedValue(new Error('lookup failed'));

      await expect(accessor.writeDocument(identifier, data, metadata, {
        existingStorageHints: {
          contentType: { candidates: [ 'application/json' ], exhaustive: false },
        },
      })).rejects.toThrow('lookup failed');

      expect(Object.keys(cache.data['.internal'].tempFiles)).toHaveLength(0);
      expect(cache.data['resource$.json']).toBeUndefined();
    });

    it('retains extension discovery when write options are absent.', async(): Promise<void> => {
      const identifier = { path: `${base}resource` };
      const mapSpy = jest.spyOn(mapper, 'mapUrlToFilePath');

      await accessor.writeDocument(identifier, data, metadata);

      expect(mapSpy).toHaveBeenCalledWith(identifier, false);
    });

    it('writes metadata to the corresponding metadata file.', async(): Promise<void> => {
      metadata = new RepresentationMetadata(
        { path: `${base}res.ttl` },
        { [CONTENT_TYPE]: 'text/turtle', likes: 'apples' },
      );
      await expect(accessor.writeDocument({ path: `${base}res.ttl` }, data, metadata)).resolves.toBeUndefined();
      expect(cache.data['res.ttl']).toBe('data');
      expect(cache.data['res.ttl.meta']).toMatch(`<${base}res.ttl> <likes> "apples".`);
    });

    it('should delete temp file when done writing.', async(): Promise<void> => {
      await expect(accessor.writeDocument({ path: `${base}resource` }, data, metadata)).resolves.toBeUndefined();
      expect(Object.keys(cache.data['.internal'].tempFiles)).toHaveLength(0);
      expect(cache.data.resource).toBe('data');
    });

    it('should throw an error when writing the data goes wrong.', async(): Promise<void> => {
      jest.spyOn(data, 'read').mockImplementation((): any => {
        data.emit('error', new Error('error'));
        return null;
      });
      jest.spyOn(jest.requireMock('fs-extra'), 'stat').mockImplementation((): any => ({
        isFile: (): boolean => false,
      }));
      await expect(accessor.writeDocument({ path: `${base}res.ttl` }, data, metadata)).rejects.toThrow('error');
    });

    it('should throw when renaming / moving the file goes wrong.', async(): Promise<void> => {
      jest.spyOn(jest.requireMock('fs-extra'), 'rename').mockImplementation((): any => {
        throw new Error('error');
      });
      jest.spyOn(jest.requireMock('fs-extra'), 'stat').mockImplementation((): any => ({
        isFile: (): boolean => true,
      }));
      await expect(accessor.writeDocument({ path: `${base}res.ttl` }, data, metadata)).rejects.toThrow('error');
    });

    it('should (on error) not unlink the temp file if it does not exist.', async(): Promise<void> => {
      jest.spyOn(jest.requireMock('fs-extra'), 'rename').mockImplementation((): any => {
        throw new Error('error');
      });
      jest.spyOn(jest.requireMock('fs-extra'), 'stat').mockImplementation((): any => ({
        isFile: (): boolean => false,
      }));
      await expect(accessor.writeDocument({ path: `${base}res.ttl` }, data, metadata)).rejects.toThrow('error');
    });

    it(
      'should throw when renaming / moving the file goes wrong and the temp file does not exist.',
      async(): Promise<void> => {
        jest.spyOn(jest.requireMock('fs-extra'), 'rename').mockImplementation((): any => {
          throw new Error('error');
        });
        jest.spyOn(jest.requireMock('fs-extra'), 'stat').mockImplementation();
        await expect(accessor.writeDocument({ path: `${base}res.ttl` }, data, metadata)).rejects.toThrow('error');
      },
    );
  });
});
