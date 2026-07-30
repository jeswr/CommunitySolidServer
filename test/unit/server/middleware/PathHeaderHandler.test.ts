import { createRequest, createResponse } from 'node-mocks-http';
import type { ResourceIdentifier, TargetExtractor } from '../../../../src';
import { joinUrl } from '../../../../src';
import type { HttpRequest } from '../../../../src/server/HttpRequest';
import type { HttpResponse } from '../../../../src/server/HttpResponse';
import { PathHeaderHandler } from '../../../../src/server/middleware/PathHeaderHandler';
import { guardStream } from '../../../../src/util/GuardedStream';

describe('A PathHeaderHandler', (): void => {
  const baseUrl = 'http://test.com/';
  const headers = { 'Cache-Control': 'public, max-age=3600', Vary: 'Origin' };
  let targetExtractor: jest.Mocked<TargetExtractor>;
  let request: HttpRequest;
  let response: HttpResponse;
  let handler: PathHeaderHandler;

  beforeEach((): void => {
    request = guardStream(createRequest({ method: 'GET', url: '/.well-known/openid-configuration' }));
    response = createResponse() as HttpResponse;

    targetExtractor = {
      handleSafe: jest.fn(({ request: req }): ResourceIdentifier => ({ path: joinUrl(baseUrl, req.url) })),
    } as any;

    handler = new PathHeaderHandler({
      baseUrl,
      targetExtractor,
      headers,
      allowedMethods: [ 'GET', 'HEAD' ],
      allowedPathNames: [ '^/\\.well-known/openid-configuration$' ],
    });
  });

  it('errors if there is no url.', async(): Promise<void> => {
    delete request.url;
    await expect(handler.canHandle({ request, response })).rejects.toThrow('Cannot handle request without a url');
  });

  it('sets the configured headers on a matching request.', async(): Promise<void> => {
    await handler.handleSafe({ request, response });
    expect(response.getHeaders()).toEqual(expect.objectContaining({
      'cache-control': 'public, max-age=3600',
      vary: 'Origin',
    }));
  });

  it('overrides any header that was already set.', async(): Promise<void> => {
    response.setHeader('Vary', 'Accept,Authorization,Origin');
    await handler.handleSafe({ request, response });
    expect(response.getHeader('vary')).toBe('Origin');
  });

  it('does not set the headers on a non-matching path.', async(): Promise<void> => {
    request.url = '/.oidc/token';
    await expect(handler.handleSafe({ request, response })).rejects.toThrow('Cannot handle route /.oidc/token');
    expect(response.getHeader('cache-control')).toBeUndefined();
  });

  it('does not set the headers on a non-matching method.', async(): Promise<void> => {
    request.method = 'POST';
    await expect(handler.handleSafe({ request, response })).rejects.toThrow('POST is not allowed.');
    expect(response.getHeader('cache-control')).toBeUndefined();
    delete request.method;
    await expect(handler.handleSafe({ request, response })).rejects.toThrow('UNKNOWN is not allowed.');
    expect(response.getHeader('cache-control')).toBeUndefined();
  });
});
