import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import type { Logger } from '../../../../src/logging/Logger';
import { getLoggerFor } from '../../../../src/logging/LogUtil';
import { MetricsServerConfigurator } from '../../../../src/server/metrics/MetricsServerConfigurator';
import type { PrometheusMetrics } from '../../../../src/server/metrics/PrometheusMetrics';

jest.mock('../../../../src/logging/LogUtil', (): any => {
  const logger: Logger = { error: jest.fn() } as any;
  return { getLoggerFor: (): Logger => logger };
});

describe('A MetricsServerConfigurator', (): void => {
  const logger: jest.Mocked<Logger> = getLoggerFor('mock') as any;
  let server: Server;
  let request: any;
  let response: any;
  let stopTimer: jest.Mock;
  let metrics: jest.Mocked<PrometheusMetrics>;
  let configurator: MetricsServerConfigurator;

  beforeEach(async(): Promise<void> => {
    jest.clearAllMocks();

    server = new EventEmitter() as any;

    request = { method: 'GET', url: '/foo' };

    response = Object.assign(new EventEmitter(), {
      statusCode: 200,
      write: jest.fn(),
      writeHead: jest.fn(),
      end: jest.fn(),
      setHeader: jest.fn(),
    });

    stopTimer = jest.fn();
    metrics = {
      requestDuration: { startTimer: jest.fn().mockReturnValue(stopTimer) },
      requestsTotal: { inc: jest.fn() },
    } as any;

    configurator = new MetricsServerConfigurator(metrics);
    await configurator.handle(server);
  });

  it('starts a timer per request but only records once the response finishes.', (): void => {
    server.emit('request', request, response);
    expect(metrics.requestDuration.startTimer).toHaveBeenCalledTimes(1);
    expect(metrics.requestsTotal.inc).toHaveBeenCalledTimes(0);

    response.emit('finish');
    expect(metrics.requestsTotal.inc).toHaveBeenCalledTimes(1);
    expect(metrics.requestsTotal.inc).toHaveBeenLastCalledWith({ method: 'GET', code: 200 });
    expect(stopTimer).toHaveBeenCalledTimes(1);
    expect(stopTimer).toHaveBeenLastCalledWith({ method: 'GET', code: 200 });
  });

  it('never writes to the response.', (): void => {
    server.emit('request', request, response);
    response.emit('finish');
    expect(response.write).toHaveBeenCalledTimes(0);
    expect(response.writeHead).toHaveBeenCalledTimes(0);
    expect(response.end).toHaveBeenCalledTimes(0);
    expect(response.setHeader).toHaveBeenCalledTimes(0);
  });

  it('uses a placeholder label when the request method is undefined.', (): void => {
    request.method = undefined;
    server.emit('request', request, response);
    response.emit('finish');
    expect(metrics.requestsTotal.inc).toHaveBeenLastCalledWith({ method: 'UNKNOWN', code: 200 });
  });

  it('does not throw or break the request flow when recording fails.', (): void => {
    metrics.requestsTotal.inc.mockImplementation((): never => {
      throw new Error('boom');
    });
    server.emit('request', request, response);
    expect((): boolean => response.emit('finish')).not.toThrow();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenLastCalledWith(expect.stringContaining('Unable to record request metrics'));
  });

  it('does not throw when the timer cannot be started.', (): void => {
    metrics.requestDuration.startTimer.mockImplementation((): never => {
      throw new Error('no timer');
    });
    expect((): void => {
      server.emit('request', request, response);
    }).not.toThrow();
    expect(metrics.requestsTotal.inc).toHaveBeenCalledTimes(0);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenLastCalledWith(expect.stringContaining('Unable to instrument request for metrics'));
  });
});
