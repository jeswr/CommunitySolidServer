import { MetricsSaturationCollector } from '../../../../src/server/metrics/MetricsSaturationCollector';
import { PrometheusMetrics } from '../../../../src/server/metrics/PrometheusMetrics';
import type { StreamingHttpMap } from '../../../../src/server/notifications/StreamingHttpChannel2023/StreamingHttpMap';
import type { WebSocketMap } from '../../../../src/server/notifications/WebSocketChannel2023/WebSocketMap';
import type { MemoryResourceLocker } from '../../../../src/util/locking/MemoryResourceLocker';

describe('A MetricsSaturationCollector', (): void => {
  let metrics: PrometheusMetrics;

  beforeEach((): void => {
    metrics = new PrometheusMetrics();
  });

  afterEach((): void => {
    metrics.registry.clear();
  });

  // Scraping the registry triggers each gauge's `collect` callback; return the matching metric.
  async function getGauge(name: string): Promise<any> {
    const json = await metrics.registry.getMetricsAsJSON();
    return json.find((metric): boolean => metric.name === name);
  }

  it('registers both saturation gauges on the metrics registry.', (): void => {
    // eslint-disable-next-line no-new
    new MetricsSaturationCollector(metrics);
    expect(metrics.registry.getSingleMetric('solid_resource_locks')).toBeDefined();
    expect(metrics.registry.getSingleMetric('solid_notification_connections')).toBeDefined();
  });

  it('reports the current held-lock count when a locker is provided.', async(): Promise<void> => {
    const locker = { getLockCount: jest.fn().mockReturnValue(3) } as unknown as jest.Mocked<MemoryResourceLocker>;
    // eslint-disable-next-line no-new
    new MetricsSaturationCollector(metrics, locker);

    const gauge = await getGauge('solid_resource_locks');
    expect(gauge?.type).toBe('gauge');
    expect(gauge?.values).toContainEqual(expect.objectContaining({ value: 3, labels: {}}));
    expect(locker.getLockCount).toHaveBeenCalledTimes(1);
  });

  it('reads the lock count fresh on every scrape.', async(): Promise<void> => {
    const getLockCount = jest.fn<number, []>().mockReturnValueOnce(1).mockReturnValueOnce(4);
    const locker = { getLockCount } as unknown as MemoryResourceLocker;
    // eslint-disable-next-line no-new
    new MetricsSaturationCollector(metrics, locker);

    expect((await getGauge('solid_resource_locks'))?.values).toContainEqual(expect.objectContaining({ value: 1 }));
    expect((await getGauge('solid_resource_locks'))?.values).toContainEqual(expect.objectContaining({ value: 4 }));
    expect(getLockCount).toHaveBeenCalledTimes(2);
  });

  it('reports 0 held locks when no locker is provided.', async(): Promise<void> => {
    // eslint-disable-next-line no-new
    new MetricsSaturationCollector(metrics);

    const gauge = await getGauge('solid_resource_locks');
    expect(gauge?.values).toEqual([ expect.objectContaining({ value: 0, labels: {}}) ]);
  });

  it('reports active connections per channel type when both maps are provided.', async(): Promise<void> => {
    const webSocketMap = { size: 2 } as unknown as WebSocketMap;
    const streamingHttpMap = { size: 5 } as unknown as StreamingHttpMap;
    // eslint-disable-next-line no-new
    new MetricsSaturationCollector(metrics, undefined, webSocketMap, streamingHttpMap);

    const gauge = await getGauge('solid_notification_connections');
    expect(gauge?.type).toBe('gauge');
    expect(gauge?.values).toContainEqual(expect.objectContaining({ value: 2, labels: { type: 'websocket' }}));
    expect(gauge?.values).toContainEqual(expect.objectContaining({ value: 5, labels: { type: 'streaming' }}));
  });

  it('omits a channel type label when its map is not provided.', async(): Promise<void> => {
    const webSocketMap = { size: 7 } as unknown as WebSocketMap;
    // eslint-disable-next-line no-new
    new MetricsSaturationCollector(metrics, undefined, webSocketMap);

    const gauge = await getGauge('solid_notification_connections');
    expect(gauge?.values).toEqual([ expect.objectContaining({ value: 7, labels: { type: 'websocket' }}) ]);
  });

  it('omits the connection gauge values entirely when no maps are provided.', async(): Promise<void> => {
    // eslint-disable-next-line no-new
    new MetricsSaturationCollector(metrics);

    const gauge = await getGauge('solid_notification_connections');
    expect(gauge?.values).toEqual([]);
    await expect(metrics.registry.getSingleMetricAsString('solid_notification_connections'))
      .resolves.not.toContain('solid_notification_connections{');
  });
});
