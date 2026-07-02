import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { PassThrough, Readable } from 'node:stream';
import { createResponse } from 'node-mocks-http';
import { StaticAssetEntry, StaticAssetHandler } from '../../../../src/server/middleware/StaticAssetHandler';
import { InternalServerError } from '../../../../src/util/errors/InternalServerError';
import { NotFoundHttpError } from '../../../../src/util/errors/NotFoundHttpError';
import type { SystemError } from '../../../../src/util/errors/SystemError';
import { getModuleRoot, joinFilePath } from '../../../../src/util/PathUtil';

const createReadStream = jest.spyOn(fs, 'createReadStream')
  .mockImplementation((): any => Readable.from([ 'file contents' ]));

const mtime = new Date('2022-05-05T12:00:00.500Z');
const stats = {
  size: 100,
  mtime,
  mtimeMs: mtime.getTime(),
  isDirectory: (): boolean => false,
};
const eTag = `W/"${stats.size}-${stats.mtimeMs}"`;
const lastModified = 'Thu, 05 May 2022 12:00:00 GMT';

const stat = jest.spyOn(fs.promises, 'stat')
  .mockImplementation(async(): Promise<any> => stats);

describe('A StaticAssetHandler', (): void => {
  const assets = [
    new StaticAssetEntry('/', '/assets/README.md'),
    new StaticAssetEntry('/foo/bar/style', '/assets/styles/bar.css'),
    new StaticAssetEntry('/foo/bar/main', '/assets/scripts/bar.js'),
    new StaticAssetEntry('/foo/bar/unknown', '/assets/bar.unknown'),
    new StaticAssetEntry('/foo/bar/cwd', 'paths/cwd.txt'),
    new StaticAssetEntry('/foo/bar/module', '@css:paths/module.txt'),
    new StaticAssetEntry('/foo/bar/document/', '/assets/document.txt'),
    new StaticAssetEntry('/foo/bar/folder/', '/assets/folders/1/'),
    new StaticAssetEntry('/foo/bar/folder/subfolder/', '/assets/folders/2/'),
  ];

  const handler = new StaticAssetHandler(assets, 'http://localhost:3000');

  afterEach(jest.clearAllMocks);

  it('does not handle POST requests.', async(): Promise<void> => {
    const request = { method: 'POST' };
    await expect(handler.canHandle({ request } as any)).rejects
      .toThrow('Only GET and HEAD requests are supported');
  });

  it('does not handle requests without URL.', async(): Promise<void> => {
    const request = { method: 'GET' };
    await expect(handler.canHandle({ request } as any)).rejects
      .toThrow('No static resource');
  });

  it('does not handle requests with unconfigured URLs.', async(): Promise<void> => {
    const request = { method: 'GET', headers: {}, url: '/other' };
    await expect(handler.canHandle({ request } as any)).rejects
      .toThrow('No static resource');
  });

  it('handles a GET request to a known URL.', async(): Promise<void> => {
    const request = { method: 'GET', headers: {}, url: '/foo/bar/style' };
    const response = createResponse({ eventEmitter: EventEmitter });
    const responseEnd = new Promise((resolve): any => response.on('end', resolve));
    await handler.handleSafe({ request, response } as any);

    expect(response.statusCode).toBe(200);
    expect(response.getHeaders()).toHaveProperty('content-type', 'text/css');
    expect(response.getHeaders()).toHaveProperty('etag', eTag);
    expect(response.getHeaders()).toHaveProperty('last-modified', lastModified);

    await responseEnd;
    expect(stat).toHaveBeenCalledTimes(1);
    expect(stat).toHaveBeenCalledWith('/assets/styles/bar.css');
    expect(createReadStream).toHaveBeenCalledTimes(1);
    expect(createReadStream).toHaveBeenCalledWith('/assets/styles/bar.css');
    expect(response._getData()).toBe('file contents');
  });

  it('handles a HEAD request to a known URL without opening the file.', async(): Promise<void> => {
    const request = { method: 'HEAD', headers: {}, url: '/foo/bar/main' };
    const response = createResponse({ eventEmitter: EventEmitter });
    const responseEnd = new Promise((resolve): any => response.on('end', resolve));
    await handler.handleSafe({ request, response } as any);

    expect(response.statusCode).toBe(200);
    expect(response.getHeaders()).toHaveProperty('content-type', 'application/javascript');
    expect(response.getHeaders()).toHaveProperty('etag', eTag);
    expect(response.getHeaders()).toHaveProperty('last-modified', lastModified);

    await responseEnd;
    expect(createReadStream).toHaveBeenCalledTimes(0);
    expect(response._getData()).toBe('');
  });

  it('sends a 304 response when the If-None-Match header matches the ETag.', async(): Promise<void> => {
    const request = { method: 'GET', headers: { 'if-none-match': eTag }, url: '/foo/bar/style' };
    const response = createResponse({ eventEmitter: EventEmitter });
    await handler.handleSafe({ request, response } as any);

    expect(response.statusCode).toBe(304);
    expect(response.getHeaders()).toHaveProperty('etag', eTag);
    expect(response.getHeaders()).toHaveProperty('last-modified', lastModified);
    expect(response.getHeaders()).not.toHaveProperty('content-type');
    expect(createReadStream).toHaveBeenCalledTimes(0);
    expect(response._getData()).toBe('');
  });

  it('sends a 304 response when the If-None-Match header contains the ETag in a list.', async(): Promise<void> => {
    const request = {
      method: 'GET',
      headers: { 'if-none-match': `"abc", ${eTag}, "def"` },
      url: '/foo/bar/style',
    };
    const response = createResponse({ eventEmitter: EventEmitter });
    await handler.handleSafe({ request, response } as any);

    expect(response.statusCode).toBe(304);
    expect(createReadStream).toHaveBeenCalledTimes(0);
  });

  it('sends a 304 response when the If-None-Match header is *.', async(): Promise<void> => {
    const request = { method: 'GET', headers: { 'if-none-match': '*' }, url: '/foo/bar/style' };
    const response = createResponse({ eventEmitter: EventEmitter });
    await handler.handleSafe({ request, response } as any);

    expect(response.statusCode).toBe(304);
    expect(createReadStream).toHaveBeenCalledTimes(0);
  });

  it('ignores W/ prefixes when comparing ETags.', async(): Promise<void> => {
    // The strong version of the weak ETag generated by the handler
    const request = { method: 'GET', headers: { 'if-none-match': eTag.slice(2) }, url: '/foo/bar/style' };
    const response = createResponse({ eventEmitter: EventEmitter });
    await handler.handleSafe({ request, response } as any);

    expect(response.statusCode).toBe(304);
    expect(createReadStream).toHaveBeenCalledTimes(0);
  });

  it('sends the asset when the If-None-Match header does not match the ETag.', async(): Promise<void> => {
    const request = { method: 'GET', headers: { 'if-none-match': '"abc"' }, url: '/foo/bar/style' };
    const response = createResponse({ eventEmitter: EventEmitter });
    const responseEnd = new Promise((resolve): any => response.on('end', resolve));
    await handler.handleSafe({ request, response } as any);

    expect(response.statusCode).toBe(200);
    await responseEnd;
    expect(createReadStream).toHaveBeenCalledTimes(1);
    expect(response._getData()).toBe('file contents');
  });

  it('ignores the If-Modified-Since header if there is an If-None-Match header.', async(): Promise<void> => {
    const request = {
      method: 'GET',
      headers: { 'if-none-match': '"abc"', 'if-modified-since': mtime.toUTCString() },
      url: '/foo/bar/style',
    };
    const response = createResponse({ eventEmitter: EventEmitter });
    await handler.handleSafe({ request, response } as any);

    expect(response.statusCode).toBe(200);
    expect(createReadStream).toHaveBeenCalledTimes(1);
  });

  it('sends a 304 response when the asset is not newer than the If-Modified-Since date.', async(): Promise<void> => {
    // The mtime of the asset is truncated to whole seconds, so this date matches despite the extra milliseconds
    const request = { method: 'GET', headers: { 'if-modified-since': lastModified }, url: '/foo/bar/style' };
    const response = createResponse({ eventEmitter: EventEmitter });
    await handler.handleSafe({ request, response } as any);

    expect(response.statusCode).toBe(304);
    expect(response.getHeaders()).toHaveProperty('etag', eTag);
    expect(response.getHeaders()).toHaveProperty('last-modified', lastModified);
    expect(createReadStream).toHaveBeenCalledTimes(0);
    expect(response._getData()).toBe('');
  });

  it('sends the asset when it was modified after the If-Modified-Since header.', async(): Promise<void> => {
    const modifiedSince = new Date(mtime.getTime() - 10000).toUTCString();
    const request = { method: 'GET', headers: { 'if-modified-since': modifiedSince }, url: '/foo/bar/style' };
    const response = createResponse({ eventEmitter: EventEmitter });
    await handler.handleSafe({ request, response } as any);

    expect(response.statusCode).toBe(200);
    expect(createReadStream).toHaveBeenCalledTimes(1);
  });

  it('ignores an invalid If-Modified-Since header.', async(): Promise<void> => {
    const request = { method: 'GET', headers: { 'if-modified-since': 'not a date' }, url: '/foo/bar/style' };
    const response = createResponse({ eventEmitter: EventEmitter });
    await handler.handleSafe({ request, response } as any);

    expect(response.statusCode).toBe(200);
    expect(createReadStream).toHaveBeenCalledTimes(1);
  });

  it('throws a 404 when the stat call reports a missing file.', async(): Promise<void> => {
    const request = { method: 'GET', headers: {}, url: '/foo/bar/main' };
    const response = createResponse({ eventEmitter: EventEmitter });
    const error = new Error('no file') as SystemError;
    error.code = 'ENOENT';
    stat.mockRejectedValueOnce(error);

    await expect(handler.handleSafe({ request, response } as any)).rejects
      .toThrow(NotFoundHttpError);
    expect(createReadStream).toHaveBeenCalledTimes(0);
  });

  it('throws a 404 when the stat call reports a folder.', async(): Promise<void> => {
    const request = { method: 'GET', headers: {}, url: '/foo/bar/main' };
    const response = createResponse({ eventEmitter: EventEmitter });
    const error = new Error('is directory') as SystemError;
    error.code = 'EISDIR';
    stat.mockRejectedValueOnce(error);

    await expect(handler.handleSafe({ request, response } as any)).rejects
      .toThrow(NotFoundHttpError);
    expect(createReadStream).toHaveBeenCalledTimes(0);
  });

  it('throws a 404 when the asset is a folder.', async(): Promise<void> => {
    const request = { method: 'GET', headers: {}, url: '/foo/bar/main' };
    const response = createResponse({ eventEmitter: EventEmitter });
    stat.mockImplementationOnce(async(): Promise<any> => ({ ...stats, isDirectory: (): boolean => true }));

    await expect(handler.handleSafe({ request, response } as any)).rejects
      .toThrow(NotFoundHttpError);
    expect(createReadStream).toHaveBeenCalledTimes(0);
  });

  it('handles a request where the stat call errors.', async(): Promise<void> => {
    const request = { method: 'GET', headers: {}, url: '/foo/bar/main' };
    const response = createResponse({ eventEmitter: EventEmitter });
    const responseEnd = new Promise((resolve): any => response.on('end', resolve));
    stat.mockRejectedValueOnce(new Error('random error'));

    await handler.handleSafe({ request, response } as any);

    await responseEnd;
    expect(createReadStream).toHaveBeenCalledTimes(0);
    expect(response._getData()).toBe('');
  });

  it('handles a request to a known URL with a query string.', async(): Promise<void> => {
    const request = { method: 'GET', headers: {}, url: '/foo/bar/style?abc=xyz' };
    const response = createResponse({ eventEmitter: EventEmitter });
    await handler.handleSafe({ request, response } as any);

    expect(response.statusCode).toBe(200);
    expect(response.getHeaders()).toHaveProperty('content-type', 'text/css');

    expect(createReadStream).toHaveBeenCalledTimes(1);
    expect(createReadStream).toHaveBeenCalledWith('/assets/styles/bar.css');
  });

  it('handles a request for an asset with an unknown content type.', async(): Promise<void> => {
    const request = { method: 'GET', headers: {}, url: '/foo/bar/unknown' };
    const response = createResponse({ eventEmitter: EventEmitter });
    await handler.handleSafe({ request, response } as any);

    expect(response.statusCode).toBe(200);
    expect(response.getHeaders()).toHaveProperty('content-type', 'application/octet-stream');

    expect(createReadStream).toHaveBeenCalledTimes(1);
    expect(createReadStream).toHaveBeenCalledWith('/assets/bar.unknown');
  });

  it('handles a request to a known URL with a relative file path.', async(): Promise<void> => {
    const request = { method: 'GET', headers: {}, url: '/foo/bar/cwd' };
    const response = createResponse({ eventEmitter: EventEmitter });
    await handler.handleSafe({ request, response } as any);

    expect(response.statusCode).toBe(200);
    expect(response.getHeaders()).toHaveProperty('content-type', 'text/plain');

    expect(createReadStream).toHaveBeenCalledTimes(1);
    expect(createReadStream).toHaveBeenCalledWith(joinFilePath(process.cwd(), '/paths/cwd.txt'));
  });

  it('handles a request to a known URL with a relative to module file path.', async(): Promise<void> => {
    const request = { method: 'GET', headers: {}, url: '/foo/bar/module' };
    const response = createResponse({ eventEmitter: EventEmitter });
    await handler.handleSafe({ request, response } as any);

    expect(response.statusCode).toBe(200);
    expect(response.getHeaders()).toHaveProperty('content-type', 'text/plain');

    expect(createReadStream).toHaveBeenCalledTimes(1);
    expect(createReadStream).toHaveBeenCalledWith(joinFilePath(getModuleRoot(), '/paths/module.txt'));
  });

  it('throws a 404 when the file disappears between the stat call and opening it.', async(): Promise<void> => {
    const request = { method: 'GET', headers: {}, url: '/foo/bar/main' };
    const response = createResponse({ eventEmitter: EventEmitter });
    const error = new Error('no file') as SystemError;
    error.code = 'ENOENT';
    const stream = new PassThrough();
    stream._read = (): any => stream.emit('error', error);
    createReadStream.mockReturnValueOnce(stream as any);

    await expect(handler.handleSafe({ request, response } as any)).rejects
      .toThrow(NotFoundHttpError);
  });

  it('throws a 404 when the file becomes a folder between the stat call and opening it.', async(): Promise<void> => {
    const request = { method: 'GET', headers: {}, url: '/foo/bar/main' };
    const response = createResponse({ eventEmitter: EventEmitter });
    const error = new Error('is directory') as SystemError;
    error.code = 'EISDIR';
    const stream = new PassThrough();
    stream._read = (): any => stream.emit('error', error);
    createReadStream.mockReturnValueOnce(stream as any);

    await expect(handler.handleSafe({ request, response } as any)).rejects
      .toThrow(NotFoundHttpError);
  });

  it('handles a request for an asset that errors.', async(): Promise<void> => {
    const request = { method: 'GET', headers: {}, url: '/foo/bar/main' };
    const response = createResponse({ eventEmitter: EventEmitter });
    const responseEnd = new Promise((resolve): any => response.on('end', resolve));
    const error = new Error('random error');
    const stream = new PassThrough();
    stream._read = (): any => stream.emit('error', error);
    createReadStream.mockReturnValueOnce(stream as any);

    await handler.handleSafe({ request, response } as any);

    await responseEnd;
    expect(response._getData()).toBe('');
  });

  it('handles URLs with a trailing slash that link to a document.', async(): Promise<void> => {
    const request = { method: 'GET', headers: {}, url: '/foo/bar/document/' };
    const response = createResponse({ eventEmitter: EventEmitter });
    const responseEnd = new Promise((resolve): any => response.on('end', resolve));
    await handler.handleSafe({ request, response } as any);

    expect(response.statusCode).toBe(200);
    expect(response.getHeaders()).toHaveProperty('content-type', 'text/plain');

    await responseEnd;
    expect(createReadStream).toHaveBeenCalledTimes(1);
    expect(createReadStream).toHaveBeenCalledWith('/assets/document.txt');
    expect(response._getData()).toBe('file contents');
  });

  it('requires folders to be linked to URLs ending on a slash.', async(): Promise<void> => {
    expect((): StaticAssetHandler => new StaticAssetHandler([ new StaticAssetEntry('/foo', '/bar/') ], 'http://example.com/'))
      .toThrow(InternalServerError);
  });

  it('handles a request to a known folder URL defined with slash.', async(): Promise<void> => {
    const request = { method: 'GET', headers: {}, url: '/foo/bar/folder/abc/def.css?abc=def' };
    const response = createResponse({ eventEmitter: EventEmitter });
    await handler.handleSafe({ request, response } as any);

    expect(response.statusCode).toBe(200);
    expect(response.getHeaders()).toHaveProperty('content-type', 'text/css');

    expect(createReadStream).toHaveBeenCalledTimes(1);
    expect(createReadStream).toHaveBeenCalledWith('/assets/folders/1/abc/def.css');
  });

  it('prefers the longest path handler.', async(): Promise<void> => {
    const request = { method: 'GET', headers: {}, url: '/foo/bar/folder/subfolder/abc/def.css?' };
    const response = createResponse({ eventEmitter: EventEmitter });
    await handler.handleSafe({ request, response } as any);

    expect(response.statusCode).toBe(200);
    expect(response.getHeaders()).toHaveProperty('content-type', 'text/css');

    expect(createReadStream).toHaveBeenCalledTimes(1);
    expect(createReadStream).toHaveBeenCalledWith('/assets/folders/2/abc/def.css');
  });

  it('handles a request to a known folder URL with spaces.', async(): Promise<void> => {
    const request = { method: 'GET', headers: {}, url: '/foo/bar/folder/a%20b%20c/def.css' };
    const response = createResponse({ eventEmitter: EventEmitter });
    await handler.handleSafe({ request, response } as any);

    expect(response.statusCode).toBe(200);
    expect(response.getHeaders()).toHaveProperty('content-type', 'text/css');

    expect(createReadStream).toHaveBeenCalledTimes(1);
    expect(createReadStream).toHaveBeenCalledWith('/assets/folders/1/a b c/def.css');
  });

  it('does not handle a request to a known folder URL with parent path segments.', async(): Promise<void> => {
    const request = { method: 'GET', headers: {}, url: '/foo/bar/folder/../def.css' };
    const response = createResponse({ eventEmitter: EventEmitter });
    await expect(handler.canHandle({ request, response } as any))
      .rejects.toThrow('No static resource configured at /foo/bar/folder/../def.css');
  });

  it('caches responses when the expires option is set.', async(): Promise<void> => {
    const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(0);
    const cachedHandler = new StaticAssetHandler(
      [ new StaticAssetEntry('/foo/bar/style', '/assets/styles/bar.css') ],
      'http://localhost:3000',
      { expires: 86400 },
    );
    const request = { method: 'GET', headers: {}, url: '/foo/bar/style' };
    const response = createResponse();
    await cachedHandler.handleSafe({ request, response } as any);
    dateNowSpy.mockRestore();

    expect(response.statusCode).toBe(200);
    expect(response.getHeaders()).toHaveProperty('cache-control', 'max-age=86400');
    expect(response.getHeaders()).toHaveProperty('expires', 'Fri, 02 Jan 1970 00:00:00 GMT');
  });

  it('automatically expands root folder mappings to explicit files.', async(): Promise<void> => {
    createReadStream.mockImplementationOnce((): any => Readable.from([ 'file contents' ]));
    const readdirSpy = jest.spyOn(fs, 'readdirSync').mockReturnValue([
      {
        name: 'app.js',
        isFile: (): boolean => true,
        isDirectory: (): boolean => false,
        isSymbolicLink: (): boolean => false,
      },
      {
        name: 'index.js',
        isFile: (): boolean => false,
        isDirectory: (): boolean => false,
        isSymbolicLink: (): boolean => true,
      },
      {
        name: 'subdir',
        isFile: (): boolean => false,
        isDirectory: (): boolean => true,
        isSymbolicLink: (): boolean => false,
      },
    ] as any);

    const expandedHandler = new StaticAssetHandler(
      [ new StaticAssetEntry('/', '/assets/static/') ],
      'http://localhost:3000',
    );

    const request = { method: 'GET', headers: {}, url: '/app.js' };
    const response = createResponse({ eventEmitter: EventEmitter });
    await expandedHandler.handleSafe({ request, response } as any);

    expect(createReadStream).toHaveBeenCalledTimes(1);
    expect(createReadStream).toHaveBeenCalledWith('/assets/static/app.js');

    const badRequest = { method: 'GET', headers: {}, url: '/subdir/app.js' };
    await expect(expandedHandler.canHandle({ request: badRequest } as any))
      .rejects.toThrow('No static resource configured at /subdir/app.js');

    readdirSpy.mockRestore();
  });

  it('keeps catch-all behavior for non-root folder mappings.', async(): Promise<void> => {
    createReadStream.mockImplementationOnce((): any => Readable.from([ 'dynamic file' ]));
    const readdirSpy = jest.spyOn(fs, 'readdirSync');

    const catchAllHandler = new StaticAssetHandler(
      [ new StaticAssetEntry('assets/', '/static/assets/') ],
      'http://localhost:3000',
    );

    // Should not have called readdirSync since non-root folders aren't expanded
    expect(readdirSpy).not.toHaveBeenCalled();

    const request = { method: 'GET', headers: {}, url: '/assets/dynamic.js' };
    const response = createResponse({ eventEmitter: EventEmitter });
    await catchAllHandler.handleSafe({ request, response } as any);

    expect(createReadStream).toHaveBeenCalledWith('/static/assets/dynamic.js');
    readdirSpy.mockRestore();
  });

  it('throws error when folder expansion fails.', async(): Promise<void> => {
    const readdirSpy = jest.spyOn(fs, 'readdirSync').mockImplementation((): any => {
      throw new Error('Permission denied');
    });

    expect((): StaticAssetHandler => new StaticAssetHandler(
      [ new StaticAssetEntry('/', '/nonexistent/folder/') ],
      'http://localhost:3000',
    )).toThrow('Error expanding static assets from /nonexistent/folder/: Permission denied');

    readdirSpy.mockRestore();
  });
});
