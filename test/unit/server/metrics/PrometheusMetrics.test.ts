import { PrometheusMetrics } from '../../../../src/server/metrics/PrometheusMetrics';

describe('A PrometheusMetrics', (): void => {
  let metrics: PrometheusMetrics;

  beforeEach((): void => {
    metrics = new PrometheusMetrics();
  });

  afterEach((): void => {
    metrics.registry.clear();
  });

  it('creates a registry using the Prometheus content type.', (): void => {
    expect(metrics.registry.contentType).toContain('text/plain');
  });

  it('collects the default process metrics on its registry.', async(): Promise<void> => {
    // `process_start_time_seconds` is one of the metrics registered by `collectDefaultMetrics`.
    expect(metrics.registry.getSingleMetric('process_start_time_seconds')).toBeDefined();
    await expect(metrics.registry.metrics()).resolves.toContain('process_cpu_user_seconds_total');
  });

  it('creates an http_requests_total counter labelled by method and code.', async(): Promise<void> => {
    expect(metrics.registry.getSingleMetric('http_requests_total')).toBeDefined();

    metrics.requestsTotal.inc({ method: 'GET', code: 200 });

    const json = await metrics.registry.getMetricsAsJSON();
    const counter = json.find((metric): boolean => metric.name === 'http_requests_total');
    expect(counter?.type).toBe('counter');
    expect(counter?.values).toContainEqual(
      expect.objectContaining({ value: 1, labels: { method: 'GET', code: 200 }}),
    );
  });

  it('creates an http_request_duration_seconds histogram labelled by method and code.', async(): Promise<void> => {
    expect(metrics.registry.getSingleMetric('http_request_duration_seconds')).toBeDefined();

    metrics.requestDuration.observe({ method: 'POST', code: 500 }, 0.25);

    const json = await metrics.registry.getMetricsAsJSON();
    const histogram = json.find((metric): boolean => metric.name === 'http_request_duration_seconds');
    expect(histogram?.type).toBe('histogram');
    expect(histogram?.values.some((value): boolean =>
      value.labels.method === 'POST' && value.labels.code === 500)).toBe(true);
  });
});
