import { MetricsHandler } from '../../../../src/server/metrics/MetricsHandler';
import type { PrometheusMetrics } from '../../../../src/server/metrics/PrometheusMetrics';

describe('A MetricsHandler', (): void => {
  const contentType = 'text/plain; version=0.0.4; charset=utf-8';
  let registry: { metrics: jest.Mock; contentType: string };
  let metrics: jest.Mocked<PrometheusMetrics>;
  let response: { writeHead: jest.Mock; end: jest.Mock };
  let handler: MetricsHandler;

  beforeEach((): void => {
    registry = {
      metrics: jest.fn().mockResolvedValue('# metrics body'),
      contentType,
    };
    metrics = { registry } as any;

    response = {
      writeHead: jest.fn(),
      end: jest.fn(),
    };

    handler = new MetricsHandler(metrics);
  });

  it('rejects non-GET requests.', async(): Promise<void> => {
    const request = { method: 'POST', url: '/metrics' };
    await expect(handler.canHandle({ request } as any)).rejects.toThrow('Only GET requests are supported');
  });

  it('rejects GET requests on a different path.', async(): Promise<void> => {
    const request = { method: 'GET', url: '/other' };
    await expect(handler.canHandle({ request } as any)).rejects.toThrow('Only /metrics is supported');
  });

  it('rejects GET requests without a URL.', async(): Promise<void> => {
    const request = { method: 'GET' };
    await expect(handler.canHandle({ request } as any)).rejects.toThrow('Only /metrics is supported');
  });

  it('accepts GET requests on the metrics path, ignoring the query string.', async(): Promise<void> => {
    const request = { method: 'GET', url: '/metrics?foo=bar' };
    await expect(handler.canHandle({ request } as any)).resolves.toBeUndefined();
  });

  it('serves the registry contents with the registry content type.', async(): Promise<void> => {
    await handler.handle({ response } as any);

    expect(registry.metrics).toHaveBeenCalledTimes(1);
    expect(response.writeHead).toHaveBeenCalledTimes(1);
    expect(response.writeHead).toHaveBeenLastCalledWith(200, { 'content-type': contentType });
    expect(response.end).toHaveBeenCalledTimes(1);
    expect(response.end).toHaveBeenLastCalledWith('# metrics body');
  });

  it('exposes the metrics on a configurable path.', async(): Promise<void> => {
    handler = new MetricsHandler(metrics, '/internal/metrics');
    await expect(handler.canHandle({ request: { method: 'GET', url: '/metrics' }} as any)).rejects
      .toThrow('Only /internal/metrics is supported');
    await expect(handler.canHandle({ request: { method: 'GET', url: '/internal/metrics' }} as any)).resolves
      .toBeUndefined();
  });
});
