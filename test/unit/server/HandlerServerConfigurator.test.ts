import { EventEmitter } from 'node:events';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { getRequestId } from '../../../src/logging/LogContext';
import type { Logger } from '../../../src/logging/Logger';
import { getLoggerFor } from '../../../src/logging/LogUtil';
import { HandlerServerConfigurator } from '../../../src/server/HandlerServerConfigurator';
import type { HttpHandler } from '../../../src/server/HttpHandler';
import { flushPromises } from '../../util/Util';

jest.mock('../../../src/logging/LogUtil', (): any => {
  const logger: Logger =
    { error: jest.fn(), info: jest.fn() } as any;
  return { getLoggerFor: (): Logger => logger };
});

describe('A HandlerServerConfigurator', (): void => {
  const logger: jest.Mocked<Logger> = getLoggerFor('mock') as any;
  let request: jest.Mocked<IncomingMessage>;
  let response: jest.Mocked<ServerResponse>;
  let server: Server;
  let handler: jest.Mocked<HttpHandler>;
  let listener: HandlerServerConfigurator;

  beforeEach(async(): Promise<void> => {
    // Clearing the logger mock
    jest.clearAllMocks();
    request = Readable.from('') as any;
    request.method = 'GET';
    request.url = '/';
    request.headers = {};

    response = {
      headersSent: false,
      end: jest.fn(),
      setHeader: jest.fn(),
      writeHead: jest.fn(),
    } as any;
    response.end.mockImplementation((): any => {
      (response as any).headersSent = true;
    });
    response.writeHead.mockReturnValue(response);

    server = new EventEmitter() as any;

    handler = {
      handleSafe: jest.fn((): void => {
        (response as any).headersSent = true;
      }),
    } as any;

    listener = new HandlerServerConfigurator(handler);
    await listener.handle(server);
  });

  it('sends incoming requests to the handler.', async(): Promise<void> => {
    server.emit('request', request, response);
    await flushPromises();

    expect(handler.handleSafe).toHaveBeenCalledTimes(1);
    expect(handler.handleSafe).toHaveBeenLastCalledWith({ request, response });

    expect(response.setHeader).toHaveBeenCalledTimes(0);
    expect(response.writeHead).toHaveBeenCalledTimes(0);
    expect(response.end).toHaveBeenCalledTimes(0);
  });

  it('returns a 404 when the handler does not do anything.', async(): Promise<void> => {
    handler.handleSafe.mockImplementation(jest.fn());
    server.emit('request', request, response);
    await flushPromises();

    expect(response.setHeader).toHaveBeenCalledTimes(0);
    expect(response.writeHead).toHaveBeenCalledTimes(1);
    expect(response.writeHead).toHaveBeenLastCalledWith(404);
    expect(response.end).toHaveBeenCalledTimes(1);
    expect(response.end).toHaveBeenLastCalledWith();
  });

  it('writes an error to the HTTP response without the stack trace.', async(): Promise<void> => {
    handler.handleSafe.mockRejectedValueOnce(new Error('dummyError'));
    server.emit('request', request, response);
    await flushPromises();

    expect(response.setHeader).toHaveBeenCalledTimes(1);
    expect(response.setHeader).toHaveBeenLastCalledWith('Content-Type', 'text/plain; charset=utf-8');
    expect(response.writeHead).toHaveBeenCalledTimes(1);
    expect(response.writeHead).toHaveBeenLastCalledWith(500);
    expect(response.end).toHaveBeenCalledTimes(1);
    expect(response.end).toHaveBeenLastCalledWith('Error: dummyError\n');
  });

  it('does not write an error if the response had been started.', async(): Promise<void> => {
    (response as any).headersSent = true;
    handler.handleSafe.mockRejectedValueOnce(new Error('dummyError'));
    server.emit('request', request, response);
    await flushPromises();

    expect(response.setHeader).toHaveBeenCalledTimes(0);
    expect(response.writeHead).toHaveBeenCalledTimes(0);
    expect(response.end).toHaveBeenCalledTimes(1);
    expect(response.end).toHaveBeenLastCalledWith();
  });

  it('throws unknown errors if its handler throw non-Error objects.', async(): Promise<void> => {
    handler.handleSafe.mockRejectedValueOnce('apple');
    server.emit('request', request, response);
    await flushPromises();

    expect(response.setHeader).toHaveBeenCalledTimes(1);
    expect(response.setHeader).toHaveBeenLastCalledWith('Content-Type', 'text/plain; charset=utf-8');
    expect(response.writeHead).toHaveBeenCalledTimes(1);
    expect(response.writeHead).toHaveBeenLastCalledWith(500);
    expect(response.end).toHaveBeenCalledTimes(1);
    expect(response.end).toHaveBeenLastCalledWith('Unknown error: apple.\n');
  });

  it('can handle errors on the HttpResponse.', async(): Promise<void> => {
    handler.handleSafe.mockImplementationOnce(async(input): Promise<void> => {
      input.request.emit('error', new Error('bad request'));
    });
    server.emit('request', request, response);
    await flushPromises();

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenLastCalledWith('Request error: bad request');
  });

  it('handles every request within a context that has a unique request identifier.', async(): Promise<void> => {
    let infoRequestId: string | undefined;
    let handlerRequestId: string | undefined;
    logger.info.mockImplementationOnce((): any => {
      infoRequestId = getRequestId();
    });
    handler.handleSafe.mockImplementationOnce(async(): Promise<void> => {
      handlerRequestId = getRequestId();
      (response as any).headersSent = true;
    });
    server.emit('request', request, response);
    await flushPromises();

    expect(handler.handleSafe).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(handlerRequestId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(infoRequestId).toBe(handlerRequestId);
    expect(getRequestId()).toBeUndefined();
  });

  it('derives the request identifier from a valid traceparent header.', async(): Promise<void> => {
    const traceId = '0af7651916cd43dd8448eb211c80319c';
    request.headers = { traceparent: `00-${traceId}-b7ad6b7169203331-01` };
    let handlerRequestId: string | undefined;
    handler.handleSafe.mockImplementationOnce(async(): Promise<void> => {
      handlerRequestId = getRequestId();
      (response as any).headersSent = true;
    });
    server.emit('request', request, response);
    await flushPromises();

    expect(handler.handleSafe).toHaveBeenCalledTimes(1);
    expect(handlerRequestId).toBe(traceId);
  });

  it('generates a fresh request identifier for an invalid traceparent header.', async(): Promise<void> => {
    request.headers = { traceparent: 'not-a-valid-traceparent' };
    let handlerRequestId: string | undefined;
    handler.handleSafe.mockImplementationOnce(async(): Promise<void> => {
      handlerRequestId = getRequestId();
      (response as any).headersSent = true;
    });
    server.emit('request', request, response);
    await flushPromises();

    expect(handler.handleSafe).toHaveBeenCalledTimes(1);
    expect(handlerRequestId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(handlerRequestId).not.toBe('not-a-valid-traceparent');
  });

  it('keeps the request identifier for request errors emitted outside the request context.', async(): Promise<void> => {
    let handlerRequestId: string | undefined;
    let errorRequestId: string | undefined;
    logger.error.mockImplementationOnce((): any => {
      errorRequestId = getRequestId();
    });
    handler.handleSafe.mockImplementationOnce(async(): Promise<void> => {
      handlerRequestId = getRequestId();
      (response as any).headersSent = true;
    });
    server.emit('request', request, response);
    await flushPromises();

    // This emit happens outside the request context created by the configurator
    expect(getRequestId()).toBeUndefined();
    request.emit('error', new Error('late error'));

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenLastCalledWith('Request error: late error');
    expect(errorRequestId).toBe(handlerRequestId);
    expect(errorRequestId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('prints the stack trace if that option is enabled.', async(): Promise<void> => {
    server.removeAllListeners();
    listener = new HandlerServerConfigurator(handler, true);
    await listener.handle(server);
    const error = new Error('dummyError');
    handler.handleSafe.mockRejectedValueOnce(error);
    server.emit('request', request, response);
    await flushPromises();

    expect(response.setHeader).toHaveBeenCalledTimes(1);
    expect(response.setHeader).toHaveBeenLastCalledWith('Content-Type', 'text/plain; charset=utf-8');
    expect(response.writeHead).toHaveBeenCalledTimes(1);
    expect(response.writeHead).toHaveBeenLastCalledWith(500);
    expect(response.end).toHaveBeenCalledTimes(1);
    expect(response.end).toHaveBeenLastCalledWith(`${error.stack}\n`);
  });
});
