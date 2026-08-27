import fs from 'node:fs';
import {
  ExtensionBasedMapper,
  ExtensionBasedMapperFactory,
} from '../../../../src/storage/mapping/ExtensionBasedMapper';
import type { ResourceIdentifier } from '../../../../src/http/representation/ResourceIdentifier';
import type { ResourceLink } from '../../../../src/storage/mapping/FileIdentifierMapper';
import { BadRequestHttpError } from '../../../../src/util/errors/BadRequestHttpError';
import { NotFoundHttpError } from '../../../../src/util/errors/NotFoundHttpError';
import { NotImplementedHttpError } from '../../../../src/util/errors/NotImplementedHttpError';
import { trimTrailingSlashes } from '../../../../src/util/PathUtil';

jest.mock('node:fs');

function mockDirectory(files: readonly string[]): AsyncIterable<{ name: string }> {
  return {
    async* [Symbol.asyncIterator](): AsyncIterator<{ name: string }> {
      for (const name of files) {
        yield { name };
      }
    },
  };
}

class ExposedExtensionBasedMapper extends ExtensionBasedMapper {
  public async mapDocument(identifier: ResourceIdentifier, filePath: string): Promise<ResourceLink> {
    return this.mapUrlToDocumentPath(identifier, filePath);
  }
}

describe('An ExtensionBasedMapper', (): void => {
  const base = 'http://test.com/';
  const rootFilepath = 'uploads/';
  let mapper: ExtensionBasedMapper;
  let fsPromises: Record<string, jest.Mock>;

  beforeEach(async(): Promise<void> => {
    jest.clearAllMocks();
    fs.promises = {
      opendir: jest.fn().mockRejectedValue(new Error('does not exist')),
      readdir: jest.fn(),
      stat: jest.fn().mockRejectedValue(new Error('does not exist')),
    } as any;
    fsPromises = fs.promises as any;
    mapper = new ExtensionBasedMapper(base, rootFilepath);
  });

  describe('mapUrlToFilePath', (): void => {
    it('throws 404 if the input path does not contain the base.', async(): Promise<void> => {
      await expect(mapper.mapUrlToFilePath({ path: 'invalid' }, false)).rejects.toThrow(NotFoundHttpError);
    });

    it('throws 404 if the relative path does not start with a slash.', async(): Promise<void> => {
      const result = mapper.mapUrlToFilePath({ path: `${trimTrailingSlashes(base)}test` }, false);
      await expect(result).rejects.toThrow(BadRequestHttpError);
      await expect(result).rejects.toThrow('URL needs a / after the base');
    });

    it('throws 400 if the input path contains relative parts.', async(): Promise<void> => {
      const result = mapper.mapUrlToFilePath({ path: `${base}test/../test2` }, false);
      await expect(result).rejects.toThrow(BadRequestHttpError);
      await expect(result).rejects.toThrow('Disallowed /../ segment in URL');
    });

    it('returns the corresponding file path for container identifiers.', async(): Promise<void> => {
      await expect(mapper.mapUrlToFilePath({ path: `${base}container/` }, false)).resolves.toEqual({
        identifier: { path: `${base}container/` },
        filePath: `${rootFilepath}container/`,
        isMetadata: false,
      });
    });

    it('rejects URLs that end with "$.{extension}".', async(): Promise<void> => {
      const result = mapper.mapUrlToFilePath({ path: `${base}test$.txt` }, false);
      await expect(result).rejects.toThrow(NotImplementedHttpError);
      await expect(result).rejects.toThrow('Identifiers cannot contain a dollar sign before their extension');
    });

    it('determines content-type by extension when looking in a folder that does not exist.', async(): Promise<void> => {
      fsPromises.readdir.mockImplementation((): void => {
        throw new Error('does not exist');
      });
      await expect(mapper.mapUrlToFilePath({ path: `${base}no/test.txt` }, false)).resolves.toEqual({
        identifier: { path: `${base}no/test.txt` },
        filePath: `${rootFilepath}no/test.txt`,
        contentType: 'text/plain',
        isMetadata: false,
      });
    });

    it('determines content-type by extension when looking for a file that does not exist.', async(): Promise<void> => {
      fsPromises.readdir.mockReturnValue([ 'test.ttl' ]);
      await expect(mapper.mapUrlToFilePath({ path: `${base}test.txt` }, false)).resolves.toEqual({
        identifier: { path: `${base}test.txt` },
        filePath: `${rootFilepath}test.txt`,
        contentType: 'text/plain',
        isMetadata: false,
      });
    });

    it('determines the content-type based on the extension.', async(): Promise<void> => {
      fsPromises.readdir.mockReturnValue([ 'test.txt' ]);
      await expect(mapper.mapUrlToFilePath({ path: `${base}test.txt` }, false)).resolves.toEqual({
        identifier: { path: `${base}test.txt` },
        filePath: `${rootFilepath}test.txt`,
        contentType: 'text/plain',
        isMetadata: false,
      });
    });

    it('determines the content-type correctly for metadata files.', async(): Promise<void> => {
      fsPromises.readdir.mockReturnValue([ 'test.meta' ]);
      await expect(mapper.mapUrlToFilePath({ path: `${base}test` }, true)).resolves.toEqual({
        identifier: { path: `${base}test` },
        filePath: `${rootFilepath}test.meta`,
        contentType: 'text/turtle',
        isMetadata: true,
      });
    });

    it('matches even if the content-type does not match the extension.', async(): Promise<void> => {
      fsPromises.readdir.mockReturnValue([ 'test.txt$.ttl' ]);
      await expect(mapper.mapUrlToFilePath({ path: `${base}test.txt` }, false)).resolves.toEqual({
        identifier: { path: `${base}test.txt` },
        filePath: `${rootFilepath}test.txt$.ttl`,
        contentType: 'text/turtle',
        isMetadata: false,
      });
    });

    it('generates a file path if the content-type was provided.', async(): Promise<void> => {
      await expect(mapper.mapUrlToFilePath({ path: `${base}test.txt` }, false, 'text/plain')).resolves.toEqual({
        identifier: { path: `${base}test.txt` },
        filePath: `${rootFilepath}test.txt`,
        contentType: 'text/plain',
        isMetadata: false,
      });
    });

    it('adds an extension if the given extension does not match the given content-type.', async(): Promise<void> => {
      await expect(mapper.mapUrlToFilePath({ path: `${base}test.txt` }, false, 'text/turtle')).resolves.toEqual({
        identifier: { path: `${base}test.txt` },
        filePath: `${rootFilepath}test.txt$.ttl`,
        contentType: 'text/turtle',
        isMetadata: false,
      });
    });

    it(
      'falls back to custom extension for unknown types (for which no custom mapping exists).',
      async(): Promise<void> => {
        const result = mapper.mapUrlToFilePath({ path: `${base}test` }, false, 'unknown/content-type');
        await expect(result).resolves.toEqual({
          identifier: { path: `${base}test` },
          filePath: `${rootFilepath}test$.unknown`,
          contentType: undefined,
          isMetadata: false,
        });
      },
    );

    it('supports custom types.', async(): Promise<void> => {
      const customMapper = new ExtensionBasedMapper(base, rootFilepath, { cstm: 'text/custom' });
      await expect(customMapper.mapUrlToFilePath({ path: `${base}test.cstm` }, false))
        .resolves.toEqual({
          identifier: { path: `${base}test.cstm` },
          filePath: `${rootFilepath}test.cstm`,
          contentType: 'text/custom',
          isMetadata: false,
        });
    });

    it('supports custom extensions.', async(): Promise<void> => {
      const customMapper = new ExtensionBasedMapper(base, rootFilepath, { cstm: 'text/custom' });
      await expect(customMapper.mapUrlToFilePath({ path: `${base}test` }, false, 'text/custom'))
        .resolves.toEqual({
          identifier: { path: `${base}test` },
          filePath: `${rootFilepath}test$.cstm`,
          contentType: 'text/custom',
          isMetadata: false,
        });
    });

    it('resolves an exact file name without scanning the directory.', async(): Promise<void> => {
      fsPromises.stat.mockResolvedValue(undefined);
      await expect(mapper.mapUrlToFilePath({ path: `${base}test.txt` }, false)).resolves.toEqual({
        identifier: { path: `${base}test.txt` },
        filePath: `${rootFilepath}test.txt`,
        contentType: 'text/plain',
        isMetadata: false,
      });
      expect(fsPromises.stat).toHaveBeenCalledWith(`${rootFilepath}test.txt`);
      expect(fsPromises.readdir).not.toHaveBeenCalled();
    });

    it('does not probe the folder itself for an empty document name.', async(): Promise<void> => {
      const exposedMapper = new ExposedExtensionBasedMapper(base, rootFilepath);
      fsPromises.opendir.mockResolvedValue(mockDirectory([]));
      fsPromises.stat.mockResolvedValue(undefined);

      await exposedMapper.mapDocument({ path: base }, rootFilepath);
      expect(fsPromises.stat).not.toHaveBeenCalled();
      expect(fsPromises.opendir).toHaveBeenCalledTimes(1);
    });

    it('resolves files from a sampled small directory without a full scan.', async(): Promise<void> => {
      fsPromises.opendir.mockResolvedValue(mockDirectory([ 'other$.ttl', 'test$.weird' ]));
      fsPromises.stat.mockImplementation(async(path: string): Promise<void> => {
        if (path !== `${rootFilepath}test$.weird`) {
          throw new Error('does not exist');
        }
      });
      await expect(mapper.mapUrlToFilePath({ path: `${base}test` }, false)).resolves.toEqual({
        identifier: { path: `${base}test` },
        filePath: `${rootFilepath}test$.weird`,
        contentType: 'application/octet-stream',
        isMetadata: false,
      });
      expect(fsPromises.opendir).toHaveBeenCalledWith(rootFilepath, { bufferSize: 128 });
      expect(fsPromises.readdir).not.toHaveBeenCalled();
    });

    it('resolves misses from a newly sampled small directory without a second scan.', async(): Promise<void> => {
      fsPromises.opendir.mockResolvedValue(mockDirectory([ 'other$.ttl' ]));
      await expect(mapper.mapUrlToFilePath({ path: `${base}test` }, false)).resolves.toEqual({
        identifier: { path: `${base}test` },
        filePath: `${rootFilepath}test`,
        contentType: 'application/octet-stream',
        isMetadata: false,
      });
      expect(fsPromises.readdir).not.toHaveBeenCalled();
    });

    it('probes extensions by frequency in sampled large directories.', async(): Promise<void> => {
      fsPromises.opendir.mockResolvedValue(mockDirectory([
        ...Array.from({ length: 60 }, (_value, index): string => `json-${index}$.json`),
        ...Array.from({ length: 48 }, (_value, index): string => `ttl-${index}$.ttl`),
        ...Array.from({ length: 18 }, (_value, index): string => `other-${index}$.other`),
        'extensionless',
        'empty$.',
      ]));
      fsPromises.stat.mockImplementation(async(path: string): Promise<void> => {
        if (path !== `${rootFilepath}test$.ttl`) {
          throw new Error('does not exist');
        }
      });
      await expect(mapper.mapUrlToFilePath({ path: `${base}test` }, false)).resolves.toEqual({
        identifier: { path: `${base}test` },
        filePath: `${rootFilepath}test$.ttl`,
        contentType: 'text/turtle',
        isMetadata: false,
      });
      expect(fsPromises.stat).toHaveBeenNthCalledWith(1, `${rootFilepath}test`);
      expect(fsPromises.stat).toHaveBeenNthCalledWith(2, `${rootFilepath}test$.json`);
      expect(fsPromises.stat).toHaveBeenNthCalledWith(3, `${rootFilepath}test$.ttl`);
      expect(fsPromises.readdir).not.toHaveBeenCalled();
    });

    it('limits directory sampling to 128 entries.', async(): Promise<void> => {
      let yielded = 0;
      fsPromises.opendir.mockResolvedValue({
        async* [Symbol.asyncIterator](): AsyncIterator<{ name: string }> {
          for (let index = 0; index < 200; index += 1) {
            yielded += 1;
            yield { name: `resource-${index}$.json` };
          }
        },
      });
      fsPromises.stat.mockImplementation(async(path: string): Promise<void> => {
        if (path !== `${rootFilepath}test$.json`) {
          throw new Error('does not exist');
        }
      });

      await mapper.mapUrlToFilePath({ path: `${base}test` }, false);
      expect(yielded).toBe(128);
      expect(fsPromises.readdir).not.toHaveBeenCalled();
    });

    it('limits learned profiles to the 24 most frequent extensions.', async(): Promise<void> => {
      const sample = Array.from({ length: 25 }, (_value, extension): string[] =>
        Array.from({ length: extension === 0 ? 8 : 5 }, (_entry, index): string =>
          `resource-${extension}-${index}$.ext-${extension}`)).flat();
      fsPromises.opendir.mockResolvedValue(mockDirectory(sample));
      fsPromises.readdir.mockReturnValue([ 'test$.ext-24' ]);

      await expect(mapper.mapUrlToFilePath({ path: `${base}test` }, false)).resolves.toMatchObject({
        filePath: `${rootFilepath}test$.ext-24`,
      });
      expect(fsPromises.stat).toHaveBeenCalledTimes(25);
      expect(fsPromises.stat).not.toHaveBeenCalledWith(`${rootFilepath}test$.ext-24`);
      expect(fsPromises.readdir).toHaveBeenCalledTimes(1);
    });

    it('retains only the 1,024 most recently used directory profiles.', async(): Promise<void> => {
      fsPromises.opendir.mockResolvedValue(mockDirectory([ 'test$.ttl' ]));
      fsPromises.stat.mockImplementation(async(path: string): Promise<void> => {
        if (!path.endsWith('test$.ttl')) {
          throw new Error('does not exist');
        }
      });

      for (let index = 0; index < 1_025; index += 1) {
        await mapper.mapUrlToFilePath({ path: `${base}container-${index}/test` }, false);
      }
      expect(fsPromises.opendir).toHaveBeenCalledTimes(1_025);

      await mapper.mapUrlToFilePath({ path: `${base}container-1024/test` }, false);
      expect(fsPromises.opendir).toHaveBeenCalledTimes(1_025);

      await mapper.mapUrlToFilePath({ path: `${base}container-0/test` }, false);
      expect(fsPromises.opendir).toHaveBeenCalledTimes(1_026);
    });

    it('learns configured extensions from the directory instead of a fixed list.', async(): Promise<void> => {
      const customMapper = new ExtensionBasedMapper(base, rootFilepath, { cstm: 'text/custom' });
      fsPromises.opendir.mockResolvedValue(mockDirectory(
        Array.from({ length: 65 }, (_value, index): string => `resource-${index}$.cstm`),
      ));
      fsPromises.stat.mockImplementation(async(path: string): Promise<void> => {
        if (path !== `${rootFilepath}test$.cstm`) {
          throw new Error('does not exist');
        }
      });
      await expect(customMapper.mapUrlToFilePath({ path: `${base}test` }, false)).resolves.toEqual({
        identifier: { path: `${base}test` },
        filePath: `${rootFilepath}test$.cstm`,
        contentType: 'text/custom',
        isMetadata: false,
      });
      expect(fsPromises.readdir).not.toHaveBeenCalled();
    });

    it('refreshes the profile after falling back to a directory scan.', async(): Promise<void> => {
      fsPromises.opendir.mockResolvedValue(mockDirectory(
        Array.from({ length: 65 }, (_value, index): string => `resource-${index}$.json`),
      ));
      fsPromises.readdir.mockReturnValue([
        'test$.weird',
        'other$.weird',
        ...Array.from({ length: 65 }, (_value, index): string => `resource-${index}$.weird`),
      ]);
      fsPromises.stat.mockImplementation(async(path: string): Promise<void> => {
        if (path !== `${rootFilepath}other$.weird`) {
          throw new Error('does not exist');
        }
      });
      await expect(mapper.mapUrlToFilePath({ path: `${base}test` }, false)).resolves.toEqual({
        identifier: { path: `${base}test` },
        filePath: `${rootFilepath}test$.weird`,
        contentType: 'application/octet-stream',
        isMetadata: false,
      });
      expect(fsPromises.readdir).toHaveBeenCalledWith(rootFilepath);

      await expect(mapper.mapUrlToFilePath({ path: `${base}other` }, false)).resolves.toEqual({
        identifier: { path: `${base}other` },
        filePath: `${rootFilepath}other$.weird`,
        contentType: 'application/octet-stream',
        isMetadata: false,
      });
      expect(fsPromises.readdir).toHaveBeenCalledTimes(1);
    });

    it('refreshes cached small directories when their entries change.', async(): Promise<void> => {
      fsPromises.opendir.mockResolvedValue(mockDirectory([ 'test$.old' ]));
      fsPromises.stat.mockImplementation(async(path: string): Promise<void> => {
        if (path !== `${rootFilepath}test$.old`) {
          throw new Error('does not exist');
        }
      });
      await expect(mapper.mapUrlToFilePath({ path: `${base}test` }, false)).resolves.toMatchObject({
        filePath: `${rootFilepath}test$.old`,
      });

      fsPromises.stat.mockRejectedValue(new Error('does not exist'));
      fsPromises.readdir.mockReturnValue([ 'test$.new' ]);
      await expect(mapper.mapUrlToFilePath({ path: `${base}test` }, false)).resolves.toMatchObject({
        filePath: `${rootFilepath}test$.new`,
      });
      expect(fsPromises.readdir).toHaveBeenCalledTimes(1);
    });

    it('deduplicates concurrent profile samples and fallback scans.', async(): Promise<void> => {
      fsPromises.opendir.mockResolvedValue(mockDirectory(
        Array.from({ length: 65 }, (_value, index): string => `resource-${index}$.json`),
      ));
      let resolveFiles: (files: string[]) => void;
      const files = new Promise<string[]>((resolve): void => {
        resolveFiles = resolve;
      });
      let notifyReadStarted: () => void;
      const readStarted = new Promise<void>((resolve): void => {
        notifyReadStarted = resolve;
      });
      fsPromises.readdir.mockImplementation(async(): Promise<string[]> => {
        notifyReadStarted();
        return files;
      });

      const results = Promise.all([
        mapper.mapUrlToFilePath({ path: `${base}first` }, false),
        mapper.mapUrlToFilePath({ path: `${base}second` }, false),
      ]);
      await readStarted;
      expect(fsPromises.opendir).toHaveBeenCalledTimes(1);
      expect(fsPromises.readdir).toHaveBeenCalledTimes(1);

      resolveFiles!([ 'first$.weird', 'second$.weird' ]);
      await expect(results).resolves.toEqual([
        expect.objectContaining({ filePath: `${rootFilepath}first$.weird` }),
        expect.objectContaining({ filePath: `${rootFilepath}second$.weird` }),
      ]);
    });

    it('preserves arbitrary content types in internal containers.', async(): Promise<void> => {
      fsPromises.readdir.mockReturnValue([ 'resource$.ttl' ]);
      const identifier = { path: `${base}.internal/resource` };
      await expect(mapper.mapUrlToFilePath(identifier, false)).resolves.toEqual({
        identifier,
        filePath: `${rootFilepath}.internal/resource$.ttl`,
        contentType: 'text/turtle',
        isMetadata: false,
      });
    });
  });

  describe('mapFilePathToUrl', (): void => {
    it('throws an error if the input path does not contain the root file path.', async(): Promise<void> => {
      await expect(mapper.mapFilePathToUrl('invalid', true)).rejects.toThrow(Error);
    });

    it('returns a generated identifier for directories.', async(): Promise<void> => {
      await expect(mapper.mapFilePathToUrl(`${rootFilepath}container/`, true)).resolves.toEqual({
        identifier: { path: `${base}container/` },
        filePath: `${rootFilepath}container/`,
        isMetadata: false,
      });
    });

    it('returns a generated identifier for files with corresponding content-type.', async(): Promise<void> => {
      await expect(mapper.mapFilePathToUrl(`${rootFilepath}test.txt`, false)).resolves.toEqual({
        identifier: { path: `${base}test.txt` },
        filePath: `${rootFilepath}test.txt`,
        contentType: 'text/plain',
        isMetadata: false,
      });
    });

    it('returns a generated identifier for metadata files.', async(): Promise<void> => {
      await expect(mapper.mapFilePathToUrl(`${rootFilepath}test.meta`, false)).resolves.toEqual({
        identifier: { path: `${base}test` },
        filePath: `${rootFilepath}test.meta`,
        contentType: 'text/turtle',
        isMetadata: true,
      });
    });

    it('removes appended extensions.', async(): Promise<void> => {
      await expect(mapper.mapFilePathToUrl(`${rootFilepath}test.txt$.ttl`, false)).resolves.toEqual({
        identifier: { path: `${base}test.txt` },
        filePath: `${rootFilepath}test.txt$.ttl`,
        contentType: 'text/turtle',
        isMetadata: false,
      });
    });

    it('sets the content-type to application/octet-stream if there is no extension.', async(): Promise<void> => {
      await expect(mapper.mapFilePathToUrl(`${rootFilepath}test`, false)).resolves.toEqual({
        identifier: { path: `${base}test` },
        filePath: `${rootFilepath}test`,
        contentType: 'application/octet-stream',
        isMetadata: false,
      });
    });

    it('supports custom extensions.', async(): Promise<void> => {
      const customMapper = new ExtensionBasedMapper(base, rootFilepath, { cstm: 'text/custom' });
      await expect(customMapper.mapFilePathToUrl(`${rootFilepath}test$.cstm`, false))
        .resolves.toEqual({
          identifier: { path: `${base}test` },
          filePath: `${rootFilepath}test$.cstm`,
          contentType: 'text/custom',
          isMetadata: false,
        });
    });
  });

  describe('An ExtensionBasedMapperFactory', (): void => {
    const factory = new ExtensionBasedMapperFactory();

    it('creates an ExtensionBasedMapper.', async(): Promise<void> => {
      await expect(factory.create('base', 'filePath')).resolves.toBeInstanceOf(ExtensionBasedMapper);
    });
  });
});
