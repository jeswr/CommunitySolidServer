import 'jest-rdf';
import { Readable } from 'node:stream';
import { BlobServiceClient, RestError } from '@azure/storage-blob';
import { DataFactory } from 'n3';
import type { Representation } from '../../../../src/http/representation/Representation';
import { RepresentationMetadata } from '../../../../src/http/representation/RepresentationMetadata';
import { AzureBlobDataAccessor } from '../../../../src/storage/accessors/AzureBlobDataAccessor';
import { BasicETagHandler } from '../../../../src/storage/conditions/BasicETagHandler';
import { APPLICATION_OCTET_STREAM } from '../../../../src/util/ContentTypes';
import { NotFoundHttpError } from '../../../../src/util/errors/NotFoundHttpError';
import { UnsupportedMediaTypeHttpError } from '../../../../src/util/errors/UnsupportedMediaTypeHttpError';
import type { Guarded } from '../../../../src/util/GuardedStream';
import { SingleRootIdentifierStrategy } from '../../../../src/util/identifiers/SingleRootIdentifierStrategy';
import { guardedStreamFrom, readableToString } from '../../../../src/util/StreamUtil';
import { toLiteral } from '../../../../src/util/TermUtil';
import { CONTENT_TYPE, DC, LDP, POSIX, RDF, SOLID_META, XSD } from '../../../../src/util/Vocabularies';

const { namedNode, quad } = DataFactory;

jest.mock('@azure/storage-blob', (): any => ({
  BlobServiceClient: {
    fromConnectionString: jest.fn(),
  },
  // The real class is needed so `instanceof` checks and error fields keep working
  RestError: jest.requireActual('@azure/storage-blob').RestError,
}));

const now = new Date();

/**
 * The contents and properties of a fake blob.
 */
interface BlobEntry {
  content: string;
  contentType?: string;
  contentLength?: number;
  lastModified?: Date;
}

// In-memory state representing the blobs stored in the mocked Azure container
let blobs: Map<string, BlobEntry>;
// Can be used to make specific operations fail, with keys of the form `<operation>:<blobName>`
let failures: Map<string, Error>;
let blobClients: Map<string, any>;
let blockBlobClients: Map<string, any>;

function throwFailure(key: string): void {
  const failure = failures.get(key);
  if (failure) {
    throw failure;
  }
}

function createBlobClient(name: string): any {
  return {
    download: jest.fn(async(): Promise<any> => {
      throwFailure(`download:${name}`);
      const entry = blobs.get(name);
      if (!entry) {
        throw new RestError('The specified blob does not exist.', { statusCode: 404, code: 'BlobNotFound' });
      }
      return { readableStreamBody: Readable.from([ entry.content ]), lastModified: entry.lastModified };
    }),
    getProperties: jest.fn(async(): Promise<any> => {
      throwFailure(`getProperties:${name}`);
      const entry = blobs.get(name);
      if (!entry) {
        throw new RestError('The specified blob does not exist.', { statusCode: 404, code: 'BlobNotFound' });
      }
      return { contentType: entry.contentType, contentLength: entry.contentLength, lastModified: entry.lastModified };
    }),
    deleteIfExists: jest.fn(async(): Promise<any> => {
      throwFailure(`delete:${name}`);
      return { succeeded: blobs.delete(name) };
    }),
  };
}

function createBlockBlobClient(name: string): any {
  return {
    upload: jest.fn(async(body: string, contentLength: number): Promise<void> => {
      throwFailure(`upload:${name}`);
      blobs.set(name, { content: body, contentLength, lastModified: now });
    }),
    uploadStream: jest.fn(async(stream: Readable, bufferSize?: number, maxConcurrency?: number, options?: any):
    Promise<void> => {
      throwFailure(`upload:${name}`);
      const content = await readableToString(stream);
      blobs.set(name, {
        content,
        contentType: options?.blobHTTPHeaders?.blobContentType,
        contentLength: content.length,
        lastModified: now,
      });
    }),
  };
}

function getBlobClientMock(name: string): any {
  let client = blobClients.get(name);
  if (!client) {
    client = createBlobClient(name);
    blobClients.set(name, client);
  }
  return client;
}

function getBlockBlobClientMock(name: string): any {
  let client = blockBlobClients.get(name);
  if (!client) {
    client = createBlockBlobClient(name);
    blockBlobClients.set(name, client);
  }
  return client;
}

/**
 * Mimics the result of `listBlobsByHierarchy` with a `/` delimiter for the stored fake blobs.
 */
async function* listHierarchy(prefix: string): AsyncIterableIterator<any> {
  const prefixes = new Set<string>();
  for (const [ name, entry ] of blobs) {
    if (!name.startsWith(prefix)) {
      continue;
    }
    const remainder = name.slice(prefix.length);
    const slashIndex = remainder.indexOf('/');
    if (slashIndex >= 0) {
      prefixes.add(name.slice(0, prefix.length + slashIndex + 1));
    } else {
      yield {
        kind: 'blob',
        name,
        properties: {
          contentType: entry.contentType,
          contentLength: entry.contentLength,
          lastModified: entry.lastModified,
        },
      };
    }
  }
  for (const name of prefixes) {
    yield { kind: 'prefix', name };
  }
}

describe('An AzureBlobDataAccessor', (): void => {
  const base = 'http://test.com/';
  const connectionString = 'UseDevelopmentStorage=true';
  const containerName = 'solid';
  const identifierStrategy = new SingleRootIdentifierStrategy(base);
  let containerClient: {
    getBlobClient: jest.Mock;
    getBlockBlobClient: jest.Mock;
    listBlobsByHierarchy: jest.Mock;
  };
  let getContainerClient: jest.Mock;
  let accessor: AzureBlobDataAccessor;
  let metadata: RepresentationMetadata;
  let data: Guarded<Readable>;

  beforeEach(async(): Promise<void> => {
    blobs = new Map();
    failures = new Map();
    blobClients = new Map();
    blockBlobClients = new Map();

    containerClient = {
      getBlobClient: jest.fn(getBlobClientMock),
      getBlockBlobClient: jest.fn(getBlockBlobClientMock),
      listBlobsByHierarchy: jest.fn(
        (delimiter: string, options?: { prefix?: string }): AsyncIterableIterator<any> =>
          listHierarchy(options?.prefix ?? ''),
      ),
    };
    getContainerClient = jest.fn().mockReturnValue(containerClient);
    jest.mocked(BlobServiceClient.fromConnectionString).mockClear();
    jest.mocked(BlobServiceClient.fromConnectionString).mockReturnValue({ getContainerClient } as any);

    accessor = new AzureBlobDataAccessor(connectionString, containerName, identifierStrategy);

    metadata = new RepresentationMetadata(APPLICATION_OCTET_STREAM);
    data = guardedStreamFrom([ 'data' ]);
  });

  it('creates a client for the configured account and container.', async(): Promise<void> => {
    expect(BlobServiceClient.fromConnectionString).toHaveBeenCalledTimes(1);
    expect(BlobServiceClient.fromConnectionString).toHaveBeenCalledWith(connectionString);
    expect(getContainerClient).toHaveBeenCalledTimes(1);
    expect(getContainerClient).toHaveBeenCalledWith(containerName);
  });

  it('can only handle binary data.', async(): Promise<void> => {
    await expect(accessor.canHandle({ binary: true } as Representation)).resolves.toBeUndefined();
    const result = accessor.canHandle({ binary: false } as Representation);
    await expect(result).rejects.toThrow(UnsupportedMediaTypeHttpError);
    await expect(result).rejects.toThrow('Only binary data is supported.');
  });

  describe('getting data', (): void => {
    it('throws a 404 if the identifier is not supported.', async(): Promise<void> => {
      await expect(accessor.getData({ path: 'http://wrong.com/resource' })).rejects.toThrow(NotFoundHttpError);
    });

    it('throws a 404 if the identifier does not match an existing blob.', async(): Promise<void> => {
      await expect(accessor.getData({ path: `${base}resource` })).rejects.toThrow(NotFoundHttpError);
      expect(getBlobClientMock(`${base}resource`).download).toHaveBeenCalledTimes(1);
    });

    it('throws a 404 if the identifier matches a container.', async(): Promise<void> => {
      blobs.set(`${base}container/`, { content: '', lastModified: now });
      await expect(accessor.getData({ path: `${base}container/` })).rejects.toThrow(NotFoundHttpError);
      expect(containerClient.getBlobClient).toHaveBeenCalledTimes(0);
    });

    it('returns the corresponding data.', async(): Promise<void> => {
      await expect(accessor.writeDocument({ path: `${base}resource` }, data, metadata)).resolves.toBeUndefined();
      const stream = await accessor.getData({ path: `${base}resource` });
      await expect(readableToString(stream)).resolves.toBe('data');
      expect(getBlobClientMock(`${base}resource`).download).toHaveBeenCalledTimes(1);
    });

    it('converts 404 errors that only have a BlobNotFound code.', async(): Promise<void> => {
      blobs.set(`${base}resource`, { content: 'data', lastModified: now });
      failures.set(`download:${base}resource`, new RestError('no blob', { code: 'BlobNotFound' }));
      await expect(accessor.getData({ path: `${base}resource` })).rejects.toThrow(NotFoundHttpError);
    });

    it('propagates other errors when reading data.', async(): Promise<void> => {
      blobs.set(`${base}resource`, { content: 'data', lastModified: now });
      failures.set(`download:${base}resource`, new RestError('server error', { statusCode: 500 }));
      await expect(accessor.getData({ path: `${base}resource` })).rejects.toThrow('server error');

      failures.set(`download:${base}resource`, new Error('fatal'));
      await expect(accessor.getData({ path: `${base}resource` })).rejects.toThrow('fatal');
    });
  });

  describe('getting metadata', (): void => {
    it('throws a 404 if the identifier does not match an existing blob.', async(): Promise<void> => {
      await expect(accessor.getMetadata({ path: `${base}resource` })).rejects.toThrow(NotFoundHttpError);
      await expect(accessor.getMetadata({ path: `${base}container/` })).rejects.toThrow(NotFoundHttpError);
    });

    it('throws a 404 if the trailing slash does not match its type.', async(): Promise<void> => {
      await expect(accessor.writeDocument({ path: `${base}resource` }, data, metadata)).resolves.toBeUndefined();
      await expect(accessor.getMetadata({ path: `${base}resource/` })).rejects.toThrow(NotFoundHttpError);
      await expect(accessor.writeContainer({ path: `${base}container/` }, metadata)).resolves.toBeUndefined();
      await expect(accessor.getMetadata({ path: `${base}container` })).rejects.toThrow(NotFoundHttpError);
    });

    it('generates the metadata for a document.', async(): Promise<void> => {
      blobs.set(
        `${base}resource`,
        { content: 'data', contentType: 'text/turtle', contentLength: 4, lastModified: now },
      );
      metadata = await accessor.getMetadata({ path: `${base}resource` });
      expect(metadata.identifier.value).toBe(`${base}resource`);
      expect(metadata.contentType).toBe('text/turtle');
      expect(metadata.get(RDF.terms.type)?.value).toBe(LDP.Resource);
      expect(metadata.get(POSIX.terms.size)).toEqualRdfTerm(toLiteral(4, XSD.terms.integer));
      expect(metadata.get(DC.terms.modified)).toEqualRdfTerm(toLiteral(now.toISOString(), XSD.terms.dateTime));
      expect(metadata.get(POSIX.terms.mtime))
        .toEqualRdfTerm(toLiteral(Math.floor(now.getTime() / 1000), XSD.terms.integer));
      // `dc:modified` is in the default graph
      expect(metadata.quads(null, null, null, SOLID_META.terms.ResponseMetadata)).toHaveLength(2);
    });

    it('provides the required metadata for generating ETags.', async(): Promise<void> => {
      blobs.set(
        `${base}resource`,
        { content: 'data', contentType: 'text/turtle', contentLength: 4, lastModified: now },
      );
      metadata = await accessor.getMetadata({ path: `${base}resource` });
      expect(metadata.get(DC.terms.modified)).toBeDefined();
      expect(metadata.contentType).toBeDefined();
      expect(new BasicETagHandler().getETag(metadata)).toBe(`"${now.getTime()}-text/turtle"`);
    });

    it('generates the metadata for a container.', async(): Promise<void> => {
      blobs.set(`${base}container/`, { content: '', contentLength: 0, lastModified: now });
      metadata = await accessor.getMetadata({ path: `${base}container/` });
      expect(metadata.identifier.value).toBe(`${base}container/`);
      expect(metadata.getAll(RDF.terms.type)).toEqualRdfTermArray(
        [ LDP.terms.Container, LDP.terms.BasicContainer, LDP.terms.Resource ],
      );
      expect(metadata.contentType).toBeUndefined();
      expect(metadata.get(POSIX.terms.size)).toBeUndefined();
      expect(metadata.get(DC.terms.modified)).toEqualRdfTerm(toLiteral(now.toISOString(), XSD.terms.dateTime));
      // `dc:modified` is in the default graph
      expect(metadata.quads(null, null, null, SOLID_META.terms.ResponseMetadata)).toHaveLength(1);
    });

    it('does not add timestamps or a size if the blob has no such properties.', async(): Promise<void> => {
      blobs.set(`${base}resource`, { content: 'data' });
      metadata = await accessor.getMetadata({ path: `${base}resource` });
      expect(metadata.contentType).toBeUndefined();
      expect(metadata.get(DC.terms.modified)).toBeUndefined();
      expect(metadata.get(POSIX.terms.mtime)).toBeUndefined();
      expect(metadata.get(POSIX.terms.size)).toBeUndefined();
    });

    it('adds stored metadata when requesting document metadata.', async(): Promise<void> => {
      blobs.set(`${base}resource`, { content: 'data', lastModified: now });
      blobs.set(`${base}resource.meta`, { content: '<http://this> <http://is> <http://metadata>.', lastModified: now });
      metadata = await accessor.getMetadata({ path: `${base}resource` });
      expect(metadata.quads().some((entry): boolean => entry.subject.value === 'http://this')).toBe(true);
    });

    it('adds stored metadata when requesting container metadata.', async(): Promise<void> => {
      blobs.set(`${base}container/`, { content: '', lastModified: now });
      blobs.set(
        `${base}container/.meta`,
        { content: '<http://this> <http://is> <http://metadata>.', lastModified: now },
      );
      metadata = await accessor.getMetadata({ path: `${base}container/` });
      expect(metadata.quads().some((entry): boolean => entry.subject.value === 'http://this')).toBe(true);
    });

    it('uses the metadata blob date if it is more recent.', async(): Promise<void> => {
      const later = new Date(now.getTime() + 60000);
      blobs.set(`${base}resource`, { content: 'data', lastModified: now });
      blobs.set(
        `${base}resource.meta`,
        { content: '<http://this> <http://is> <http://metadata>.', lastModified: later },
      );
      metadata = await accessor.getMetadata({ path: `${base}resource` });
      expect(metadata.get(DC.terms.modified)).toEqualRdfTerm(toLiteral(later.toISOString(), XSD.terms.dateTime));
    });

    it('ignores the metadata blob date if it has none.', async(): Promise<void> => {
      blobs.set(`${base}resource`, { content: 'data', lastModified: now });
      blobs.set(`${base}resource.meta`, { content: '<http://this> <http://is> <http://metadata>.' });
      metadata = await accessor.getMetadata({ path: `${base}resource` });
      expect(metadata.get(DC.terms.modified)).toEqualRdfTerm(toLiteral(now.toISOString(), XSD.terms.dateTime));
    });

    it('throws an error if the metadata blob contains invalid data.', async(): Promise<void> => {
      blobs.set(`${base}resource`, { content: 'data', lastModified: now });
      blobs.set(`${base}resource.meta`, { content: 'invalid metadata!.', lastModified: now });
      await expect(accessor.getMetadata({ path: `${base}resource` }))
        .rejects.toThrow('Unexpected "invalid" on line 1.');
    });

    it('propagates other errors when requesting metadata.', async(): Promise<void> => {
      blobs.set(`${base}resource`, { content: 'data', lastModified: now });
      failures.set(`getProperties:${base}resource`, new RestError('server error', { statusCode: 500 }));
      await expect(accessor.getMetadata({ path: `${base}resource` })).rejects.toThrow('server error');
    });
  });

  describe('getting children', (): void => {
    it('yields nothing for documents.', async(): Promise<void> => {
      blobs.set(`${base}resource`, { content: 'data', lastModified: now });
      const children = [];
      for await (const child of accessor.getChildren({ path: `${base}resource` })) {
        children.push(child);
      }
      expect(children).toHaveLength(0);
      expect(containerClient.listBlobsByHierarchy).toHaveBeenCalledTimes(0);
    });

    it('throws a 404 if the identifier is not supported.', async(): Promise<void> => {
      const children = accessor.getChildren({ path: 'http://wrong.com/container/' });
      await expect(children.next()).rejects.toThrow(NotFoundHttpError);
    });

    it('generates the children for a container.', async(): Promise<void> => {
      blobs.set(`${base}container/`, { content: '', lastModified: now });
      blobs.set(`${base}container/.meta`, { content: 'meta', lastModified: now });
      blobs.set(
        `${base}container/resource`,
        { content: 'data', contentType: 'text/turtle', contentLength: 4, lastModified: now },
      );
      blobs.set(`${base}container/resource.meta`, { content: 'meta', lastModified: now });
      blobs.set(`${base}container/sub/`, { content: '', lastModified: now });
      blobs.set(`${base}container/sub/deep`, { content: 'data', lastModified: now });

      const children = [];
      for await (const child of accessor.getChildren({ path: `${base}container/` })) {
        children.push(child);
      }
      expect(children).toHaveLength(2);
      expect(new Set(children.map((child): string => child.identifier.value))).toEqual(new Set([
        `${base}container/resource`,
        `${base}container/sub/`,
      ]));

      const document = children.find((child): boolean => !child.identifier.value.endsWith('/'))!;
      const documentTypes = document.getAll(RDF.terms.type).map((term): string => term.value);
      expect(documentTypes).toContain(LDP.Resource);
      expect(documentTypes).not.toContain(LDP.Container);
      expect(document.get(DC.terms.modified)).toEqualRdfTerm(toLiteral(now.toISOString(), XSD.terms.dateTime));
      expect(document.get(POSIX.terms.mtime))
        .toEqualRdfTerm(toLiteral(Math.floor(now.getTime() / 1000), XSD.terms.integer));
      expect(document.get(POSIX.terms.size)).toEqualRdfTerm(toLiteral(4, XSD.terms.integer));
      // `dc:modified` is in the default graph
      expect(document.quads(null, null, null, SOLID_META.terms.ResponseMetadata)).toHaveLength(2);

      const container = children.find((child): boolean => child.identifier.value.endsWith('/'))!;
      const containerTypes = container.getAll(RDF.terms.type).map((term): string => term.value);
      expect(containerTypes).toContain(LDP.Resource);
      expect(containerTypes).toContain(LDP.Container);
      expect(containerTypes).toContain(LDP.BasicContainer);
      expect(container.get(DC.terms.modified)).toBeUndefined();

      expect(containerClient.listBlobsByHierarchy).toHaveBeenCalledTimes(1);
      expect(containerClient.listBlobsByHierarchy).toHaveBeenCalledWith('/', { prefix: `${base}container/` });
    });

    it('handles listings that span multiple pages.', async(): Promise<void> => {
      const prefix = `${base}container/`;
      containerClient.listBlobsByHierarchy.mockImplementation((): AsyncIterableIterator<any> =>
        (async function* (): AsyncIterableIterator<any> {
          // First page, including the marker blob of the container itself and a companion blob
          yield { kind: 'blob', name: prefix, properties: { lastModified: now, contentLength: 0 }};
          yield { kind: 'blob', name: `${prefix}doc1`, properties: { lastModified: now, contentLength: 4 }};
          yield { kind: 'blob', name: `${prefix}doc1.meta`, properties: { lastModified: now, contentLength: 9 }};
          await Promise.resolve();
          // Second page, including a stray marker blob
          yield { kind: 'prefix', name: `${prefix}sub/` };
          yield { kind: 'blob', name: `${prefix}doc2`, properties: { lastModified: now, contentLength: 4 }};
          yield { kind: 'blob', name: `${prefix}stray/`, properties: { lastModified: now, contentLength: 0 }};
        })());

      const children = [];
      for await (const child of accessor.getChildren({ path: prefix })) {
        children.push(child);
      }
      expect(children).toHaveLength(3);
      expect(children.map((child): string => child.identifier.value)).toEqual([
        `${prefix}doc1`,
        `${prefix}sub/`,
        `${prefix}doc2`,
      ]);
      expect(containerClient.listBlobsByHierarchy).toHaveBeenCalledTimes(1);
    });
  });

  describe('writing a document', (): void => {
    it('throws a 404 if the identifier is not supported.', async(): Promise<void> => {
      await expect(accessor.writeDocument({ path: 'http://wrong.com/resource' }, data, metadata))
        .rejects.toThrow(NotFoundHttpError);
    });

    it('writes the data to the corresponding blob.', async(): Promise<void> => {
      await expect(accessor.writeDocument({ path: `${base}resource` }, data, metadata)).resolves.toBeUndefined();
      expect(blobs.get(`${base}resource`)?.content).toBe('data');
      expect(blobs.get(`${base}resource`)?.contentType).toBe(APPLICATION_OCTET_STREAM);
      expect(blobs.has(`${base}resource.meta`)).toBe(false);
      const blockBlobClient = getBlockBlobClientMock(`${base}resource`);
      expect(blockBlobClient.uploadStream).toHaveBeenCalledTimes(1);
      expect(blockBlobClient.uploadStream).toHaveBeenCalledWith(
        data,
        undefined,
        undefined,
        { blobHTTPHeaders: { blobContentType: APPLICATION_OCTET_STREAM }},
      );
    });

    it('writes metadata to the corresponding metadata blob before the data.', async(): Promise<void> => {
      metadata = new RepresentationMetadata(
        { path: `${base}resource` },
        { [CONTENT_TYPE]: 'text/turtle', 'http://example.com/likes': 'apples' },
      );
      await expect(accessor.writeDocument({ path: `${base}resource` }, data, metadata)).resolves.toBeUndefined();
      expect(blobs.get(`${base}resource`)?.content).toBe('data');
      expect(blobs.get(`${base}resource`)?.contentType).toBe('text/turtle');
      const companion = blobs.get(`${base}resource.meta`);
      expect(companion?.contentType).toBe('text/turtle');
      expect(companion?.content).toMatch(`<${base}resource> <http://example.com/likes> "apples".`);
      expect(containerClient.getBlockBlobClient).toHaveBeenCalledTimes(2);
      expect(containerClient.getBlockBlobClient).toHaveBeenNthCalledWith(1, `${base}resource.meta`);
      expect(containerClient.getBlockBlobClient).toHaveBeenNthCalledWith(2, `${base}resource`);
    });

    it('does not write generated metadata to the metadata blob.', async(): Promise<void> => {
      metadata = new RepresentationMetadata({ path: `${base}resource` }, {
        [CONTENT_TYPE]: 'text/turtle',
        [RDF.type]: [ LDP.terms.Resource ],
        [DC.modified]: toLiteral(now.toISOString(), XSD.terms.dateTime),
        'http://example.com/likes': 'apples',
      });
      await expect(accessor.writeDocument({ path: `${base}resource` }, data, metadata)).resolves.toBeUndefined();
      const content = blobs.get(`${base}resource.meta`)?.content;
      expect(content?.trim()).toBe(`<${base}resource> <http://example.com/likes> "apples".`);
    });

    it('does not create a metadata blob if there is only generated metadata.', async(): Promise<void> => {
      metadata.add(RDF.terms.type, LDP.terms.Resource);
      await expect(accessor.writeDocument({ path: `${base}resource` }, data, metadata)).resolves.toBeUndefined();
      expect(blobs.has(`${base}resource.meta`)).toBe(false);
      expect(getBlockBlobClientMock(`${base}resource.meta`).uploadStream).toHaveBeenCalledTimes(0);
    });

    it('deletes existing metadata if nothing new needs to be stored.', async(): Promise<void> => {
      blobs.set(`${base}resource.meta`, { content: 'metadata!', lastModified: now });
      await expect(accessor.writeDocument({ path: `${base}resource` }, data, metadata)).resolves.toBeUndefined();
      expect(blobs.has(`${base}resource.meta`)).toBe(false);
      expect(getBlobClientMock(`${base}resource.meta`).deleteIfExists).toHaveBeenCalledTimes(1);
    });

    it('deletes the metadata blob if something went wrong writing the data.', async(): Promise<void> => {
      failures.set(`upload:${base}resource`, new Error('error'));
      metadata.add(namedNode('http://example.com/likes'), 'apples');
      await expect(accessor.writeDocument({ path: `${base}resource` }, data, metadata)).rejects.toThrow('error');
      expect(blobs.has(`${base}resource.meta`)).toBe(false);
      expect(getBlobClientMock(`${base}resource.meta`).deleteIfExists).toHaveBeenCalledTimes(1);
    });

    it('does not remove the metadata blob if none was written.', async(): Promise<void> => {
      failures.set(`upload:${base}resource`, new Error('error'));
      await expect(accessor.writeDocument({ path: `${base}resource` }, data, metadata)).rejects.toThrow('error');
      // Only the deletion of the metadata write step itself, no rollback deletion
      expect(getBlobClientMock(`${base}resource.meta`).deleteIfExists).toHaveBeenCalledTimes(1);
      expect(getBlockBlobClientMock(`${base}resource.meta`).uploadStream).toHaveBeenCalledTimes(0);
    });
  });

  describe('writing a container', (): void => {
    it('throws a 404 if the identifier is not supported.', async(): Promise<void> => {
      await expect(accessor.writeContainer({ path: 'http://wrong.com/container/' }, metadata))
        .rejects.toThrow(NotFoundHttpError);
    });

    it('creates a marker blob for the container.', async(): Promise<void> => {
      await expect(accessor.writeContainer({ path: `${base}container/` }, metadata)).resolves.toBeUndefined();
      expect(blobs.get(`${base}container/`)?.content).toBe('');
      expect(blobs.has(`${base}container/.meta`)).toBe(false);
      const blockBlobClient = getBlockBlobClientMock(`${base}container/`);
      expect(blockBlobClient.upload).toHaveBeenCalledTimes(1);
      expect(blockBlobClient.upload).toHaveBeenCalledWith('', 0);
    });

    it('writes metadata to the corresponding metadata blob.', async(): Promise<void> => {
      metadata = new RepresentationMetadata({ path: `${base}container/` }, { 'http://example.com/likes': 'apples' });
      await expect(accessor.writeContainer({ path: `${base}container/` }, metadata)).resolves.toBeUndefined();
      expect(blobs.get(`${base}container/.meta`)?.content)
        .toMatch(`<${base}container/> <http://example.com/likes> "apples".`);
    });

    it('overwrites existing metadata.', async(): Promise<void> => {
      blobs.set(`${base}container/.meta`, { content: `<${base}container/> <http://example.com/likes> "pears".` });
      metadata = new RepresentationMetadata({ path: `${base}container/` }, { 'http://example.com/likes': 'apples' });
      await expect(accessor.writeContainer({ path: `${base}container/` }, metadata)).resolves.toBeUndefined();
      const content = blobs.get(`${base}container/.meta`)?.content;
      expect(content).toMatch('"apples"');
      expect(content).not.toMatch('"pears"');
    });

    it('can overwrite the metadata of an existing container without overwriting children.', async(): Promise<void> => {
      const identifier = { path: `${base}container/` };
      await expect(accessor.writeContainer(identifier, new RepresentationMetadata(identifier)))
        .resolves.toBeUndefined();
      await expect(accessor.writeDocument({ path: `${base}container/resource` }, data, metadata))
        .resolves.toBeUndefined();

      const newMetadata = new RepresentationMetadata(identifier, { 'http://example.com/likes': 'apples' });
      await expect(accessor.writeContainer(identifier, newMetadata)).resolves.toBeUndefined();

      metadata = await accessor.getMetadata(identifier);
      expect(metadata.get(namedNode('http://example.com/likes'))?.value).toBe('apples');

      const children = [];
      for await (const child of accessor.getChildren(identifier)) {
        children.push(child);
      }
      expect(children).toHaveLength(1);
      expect(children[0].identifier.value).toBe(`${base}container/resource`);
      await expect(readableToString(await accessor.getData({ path: `${base}container/resource` })))
        .resolves.toBe('data');
    });

    it('can write to the root container.', async(): Promise<void> => {
      metadata = new RepresentationMetadata({ path: base }, { 'http://example.com/likes': 'apples' });
      await expect(accessor.writeContainer({ path: base }, metadata)).resolves.toBeUndefined();
      expect(blobs.get(base)?.content).toBe('');
      expect(blobs.get(`${base}.meta`)?.content).toMatch(`<${base}> <http://example.com/likes> "apples".`);
    });
  });

  describe('writing metadata', (): void => {
    it('writes metadata to the metadata resource.', async(): Promise<void> => {
      const resourceIdentifier = { path: `${base}resource` };
      const inputMetadata = new RepresentationMetadata(resourceIdentifier, { [RDF.type]: LDP.terms.Resource });
      await accessor.writeDocument(resourceIdentifier, data, inputMetadata);

      const extraMetadata = new RepresentationMetadata(resourceIdentifier);
      extraMetadata.addQuad(namedNode(`${base}a`), namedNode(`${base}b`), namedNode(`${base}c`));
      await expect(accessor.writeMetadata(resourceIdentifier, extraMetadata)).resolves.toBeUndefined();

      const outputMetadata = await accessor.getMetadata(resourceIdentifier);
      expect(outputMetadata.quads(`${base}a`))
        .toStrictEqual([ quad(namedNode(`${base}a`), namedNode(`${base}b`), namedNode(`${base}c`)) ]);
      // The data itself remains unchanged
      await expect(readableToString(await accessor.getData(resourceIdentifier))).resolves.toBe('data');
    });
  });

  describe('deleting a resource', (): void => {
    it('throws a 404 if the identifier does not match an existing entry.', async(): Promise<void> => {
      await expect(accessor.deleteResource({ path: `${base}resource` })).rejects.toThrow(NotFoundHttpError);
    });

    it('throws a 404 if the trailing slash does not match its type.', async(): Promise<void> => {
      blobs.set(`${base}resource`, { content: 'data', lastModified: now });
      blobs.set(`${base}container/`, { content: '', lastModified: now });
      await expect(accessor.deleteResource({ path: `${base}resource/` })).rejects.toThrow(NotFoundHttpError);
      await expect(accessor.deleteResource({ path: `${base}container` })).rejects.toThrow(NotFoundHttpError);
    });

    it('removes the corresponding blobs.', async(): Promise<void> => {
      blobs.set(`${base}resource`, { content: 'data', lastModified: now });
      blobs.set(`${base}resource.meta`, { content: 'metadata', lastModified: now });
      blobs.set(`${base}container/`, { content: '', lastModified: now });
      blobs.set(`${base}container/.meta`, { content: 'metadata', lastModified: now });
      await expect(accessor.deleteResource({ path: `${base}resource` })).resolves.toBeUndefined();
      await expect(accessor.deleteResource({ path: `${base}container/` })).resolves.toBeUndefined();
      expect(blobs.size).toBe(0);
      expect(getBlobClientMock(`${base}resource`).deleteIfExists).toHaveBeenCalledTimes(1);
      expect(getBlobClientMock(`${base}resource.meta`).deleteIfExists).toHaveBeenCalledTimes(1);
      expect(getBlobClientMock(`${base}container/`).deleteIfExists).toHaveBeenCalledTimes(1);
      expect(getBlobClientMock(`${base}container/.meta`).deleteIfExists).toHaveBeenCalledTimes(1);
    });

    it('can delete the root container and write to it again.', async(): Promise<void> => {
      await expect(accessor.writeContainer({ path: base }, metadata)).resolves.toBeUndefined();
      await expect(accessor.deleteResource({ path: base })).resolves.toBeUndefined();
      await expect(accessor.getMetadata({ path: base })).rejects.toThrow(NotFoundHttpError);
      await expect(accessor.writeContainer({ path: base }, new RepresentationMetadata({ path: base })))
        .resolves.toBeUndefined();
      metadata = await accessor.getMetadata({ path: base });
      expect(metadata.getAll(RDF.terms.type)).toEqualRdfTermArray(
        [ LDP.terms.Container, LDP.terms.BasicContainer, LDP.terms.Resource ],
      );
    });

    it('converts 404 errors thrown while deleting.', async(): Promise<void> => {
      blobs.set(`${base}resource`, { content: 'data', lastModified: now });
      failures.set(
        `delete:${base}resource.meta`,
        new RestError('gone', { statusCode: 404, code: 'ContainerNotFound' }),
      );
      await expect(accessor.deleteResource({ path: `${base}resource` })).rejects.toThrow(NotFoundHttpError);
    });

    it('propagates other errors thrown while deleting.', async(): Promise<void> => {
      blobs.set(`${base}resource`, { content: 'data', lastModified: now });
      failures.set(`delete:${base}resource`, new Error('fatal'));
      await expect(accessor.deleteResource({ path: `${base}resource` })).rejects.toThrow('fatal');
    });
  });
});
