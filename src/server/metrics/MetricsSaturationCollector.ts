import { Gauge } from 'prom-client';
import { Initializer } from '../../init/Initializer';
import type { MemoryResourceLocker } from '../../util/locking/MemoryResourceLocker';
import type { StreamingHttpMap } from '../notifications/StreamingHttpChannel2023/StreamingHttpMap';
import type { WebSocketMap } from '../notifications/WebSocketChannel2023/WebSocketMap';
import type { PrometheusMetrics } from './PrometheusMetrics';

/**
 * An {@link Initializer} that registers runtime *saturation* gauges on the {@link PrometheusMetrics}
 * registry when the server starts.
 *
 * Where the {@link PrometheusMetrics} request instruments describe throughput (how much traffic is
 * flowing), these gauges describe *pressure*: how close the running server is to exhausting a bounded
 * runtime resource. They observe live, single-threaded in-memory state and are therefore only
 * meaningful in a non-clustered setup.
 *
 * Two gauges are registered:
 * - `solid_resource_locks`: the number of resource locks currently held by the in-memory locker.
 * - `solid_notification_connections{type}`: the number of currently open notification connections,
 *   labelled by channel `type` (`websocket` or `streaming`).
 *
 * The label set is intentionally kept low-cardinality: the connection gauge is labelled only by the
 * fixed channel `type` and never by anything unbounded (such as a resource URL, subscription id, or
 * remote address), which would otherwise cause a cardinality explosion in the time-series database.
 *
 * Every source is *optional*: a source that is not wired in (for example a configuration without
 * WebSocket notifications, or one using a non in-memory locker) simply leaves its gauge unset. The
 * unlabelled lock gauge then reports `0` and the labelled connection gauge omits the missing label,
 * so this collector is safe to add to any configuration.
 *
 * The gauges are read lazily through a prom-client `collect` callback that fires once per `/metrics`
 * scrape. This keeps the request and notification hot paths free of any instrumentation overhead. The
 * callback performs pure, side-effect-free reads (`Map.size` / a lock count): it never mutates, locks,
 * iterates with side effects, or otherwise disturbs the observed state.
 */
export class MetricsSaturationCollector extends Initializer {
  private readonly metrics: PrometheusMetrics;
  private readonly locker?: MemoryResourceLocker;
  private readonly webSocketMap?: WebSocketMap;
  private readonly streamingHttpMap?: StreamingHttpMap;

  /**
   * @param metrics - The {@link PrometheusMetrics} whose registry the gauges are registered on.
   * @param locker - The in-memory resource locker whose held-lock count is observed. Optional.
   * @param webSocketMap - The map holding the open WebSocket notification connections. Optional.
   * @param streamingHttpMap - The map holding the open Streaming HTTP notification connections. Optional.
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

  /**
   * Registers the saturation gauges on the shared metrics registry.
   * Called once at server start-up through the primary initializer chain.
   */
  public async handle(): Promise<void> {
    // Capture the sources as locals so the `collect` callbacks (regular functions, whose `this` is the
    // gauge) can read them without aliasing the collector's `this`.
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
