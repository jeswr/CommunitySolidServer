import { Gauge } from 'prom-client';
import { Initializer } from '../../init/Initializer';
import type { MemoryResourceLocker } from '../../util/locking/MemoryResourceLocker';
import type { StreamingHttpMap } from '../notifications/StreamingHttpChannel2023/StreamingHttpMap';
import type { WebSocketMap } from '../notifications/WebSocketChannel2023/WebSocketMap';
import type { PrometheusMetrics } from './PrometheusMetrics';

/**
 * An {@link Initializer} that registers saturation gauges on the {@link PrometheusMetrics} registry:
 * `solid_resource_locks` (resource locks currently held by the in-memory locker) and
 * `solid_notification_connections{type}` (open notification connections per channel type).
 * The sources are only read on each `/metrics` scrape, through a prom-client `collect` callback,
 * so the request and notification hot paths are untouched.
 * Every source is optional: an absent source leaves its gauge unset.
 */
export class MetricsSaturationCollector extends Initializer {
  private readonly metrics: PrometheusMetrics;
  private readonly locker?: MemoryResourceLocker;
  private readonly webSocketMap?: WebSocketMap;
  private readonly streamingHttpMap?: StreamingHttpMap;

  /**
   * @param metrics - The {@link PrometheusMetrics} whose registry the gauges are registered on.
   * @param locker - Optional in-memory resource locker whose held-lock count is observed.
   * @param webSocketMap - Optional map holding the open WebSocket notification connections.
   * @param streamingHttpMap - Optional map holding the open Streaming HTTP notification connections.
   */
  public constructor(
    metrics: PrometheusMetrics,
    locker?: MemoryResourceLocker,
    webSocketMap?: WebSocketMap,
    streamingHttpMap?: StreamingHttpMap,
  ) {
    super();
    this.metrics = metrics;
    this.locker = locker;
    this.webSocketMap = webSocketMap;
    this.streamingHttpMap = streamingHttpMap;
  }

  public async handle(): Promise<void> {
    // In a `collect` callback `this` is the gauge, so capture the sources as locals.
    const { locker, webSocketMap, streamingHttpMap } = this;

    const resourceLocks = new Gauge({
      name: 'solid_resource_locks',
      help: 'Number of resource locks currently held by the in-memory resource locker.',
      registers: [],
      collect(): void {
        if (locker) {
          this.set(locker.getLockCount());
        }
      },
    });
    this.metrics.registry.registerMetric(resourceLocks);

    const notificationConnections = new Gauge<'type'>({
      name: 'solid_notification_connections',
      help: 'Number of currently open notification connections, labelled by channel type.',
      labelNames: [ 'type' ],
      registers: [],
      collect(): void {
        if (webSocketMap) {
          this.set({ type: 'websocket' }, webSocketMap.size);
        }
        if (streamingHttpMap) {
          this.set({ type: 'streaming' }, streamingHttpMap.size);
        }
      },
    });
    this.metrics.registry.registerMetric(notificationConnections);
  }
}
