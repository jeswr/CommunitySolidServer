import type { HttpRequest } from '../../../../src/server/HttpRequest';
import type { HttpResponse } from '../../../../src/server/HttpResponse';
import { HealthHandler } from '../../../../src/server/middleware/HealthHandler';
import { NotImplementedHttpError } from '../../../../src/util/errors/NotImplementedHttpError';

describe('A HealthHandler', (): void => {
  let request: HttpRequest;
  let response: jest.Mocked<HttpResponse>;
  let handler: HealthHandler;

  beforeEach(async(): Promise<void> => {
    request = { method: 'GET', url: '/.well-known/css/health' } as any;
    response = {
      writeHead: jest.fn(),
      end: jest.fn(),
    } as any;
    handler = new HealthHandler();
  });

  it('rejects requests that are not GET or HEAD requests.', async(): Promise<void> => {
    request.method = 'POST';
    await expect(handler.canHandle({ request, response })).rejects.toThrow(NotImplementedHttpError);
    expect(response.writeHead).toHaveBeenCalledTimes(0);
    expect(response.end).toHaveBeenCalledTimes(0);
  });

  it('rejects requests without a URL.', async(): Promise<void> => {
    delete request.url;
    await expect(handler.canHandle({ request, response })).rejects.toThrow(NotImplementedHttpError);
    expect(response.writeHead).toHaveBeenCalledTimes(0);
    expect(response.end).toHaveBeenCalledTimes(0);
  });

  it('rejects requests targeting a different path.', async(): Promise<void> => {
    request.url = '/other';
    await expect(handler.canHandle({ request, response })).rejects.toThrow(NotImplementedHttpError);
    expect(response.writeHead).toHaveBeenCalledTimes(0);
    expect(response.end).toHaveBeenCalledTimes(0);
  });

  it('accepts GET requests targeting the health path.', async(): Promise<void> => {
    await expect(handler.canHandle({ request, response })).resolves.toBeUndefined();
  });

  it('accepts HEAD requests targeting the health path.', async(): Promise<void> => {
    request.method = 'HEAD';
    await expect(handler.canHandle({ request, response })).resolves.toBeUndefined();
  });

  it('ignores the query string when comparing paths.', async(): Promise<void> => {
    request.url = '/.well-known/css/health?abc=xyz';
    await expect(handler.canHandle({ request, response })).resolves.toBeUndefined();
  });

  it('supports a custom path.', async(): Promise<void> => {
    handler = new HealthHandler('/health');
    request.url = '/health';
    await expect(handler.canHandle({ request, response })).resolves.toBeUndefined();
    request.url = '/.well-known/css/health';
    await expect(handler.canHandle({ request, response })).rejects.toThrow(NotImplementedHttpError);
  });

  it('writes a 200 JSON response on GET requests.', async(): Promise<void> => {
    await expect(handler.handleSafe({ request, response })).resolves.toBeUndefined();
    expect(response.writeHead).toHaveBeenCalledTimes(1);
    expect(response.writeHead).toHaveBeenCalledWith(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    });
    expect(response.end).toHaveBeenCalledTimes(1);
    expect(response.end).toHaveBeenCalledWith('{"status":"ok"}');
  });

  it('writes no body on HEAD requests.', async(): Promise<void> => {
    request.method = 'HEAD';
    await expect(handler.handleSafe({ request, response })).resolves.toBeUndefined();
    expect(response.writeHead).toHaveBeenCalledTimes(1);
    expect(response.writeHead).toHaveBeenCalledWith(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    });
    expect(response.end).toHaveBeenCalledTimes(1);
    expect(response.end).toHaveBeenCalledWith();
  });
});
