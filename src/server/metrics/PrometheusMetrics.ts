import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';

/**
 * Creates and owns a Prometheus {@link Registry} together with the instruments used to observe
 * incoming HTTP requests.
 *
 * Default process metrics (CPU, memory, event loop lag, garbage collection, ...) are collected on the
 * same registry through `collectDefaultMetrics`.
 *
 * The request instruments are intentionally kept low-cardinality: they are only labelled by the
 * request `method` and the response status `code`.
 * The request target/path is deliberately *not* used as a label:
 * the unbounded number of resource URLs would cause a cardinality explosion in the time-series database.
 *
 * For the same reason the notification delivery counter is only labelled by the channel `type`
 * and the delivery `outcome`, never by the unbounded target URL or channel id.
 */
export class PrometheusMetrics {
  public readonly registry: Registry;
  public readonly requestsTotal: Counter<'code' | 'method'>;
  public readonly requestDuration: Histogram<'code' | 'method'>;
  public readonly notificationDeliveriesTotal: Counter<'outcome' | 'type'>;

  public constructor() {
    this.registry = new Registry();
    // Collect the default Node.js/process metrics (cpu, memory, event loop lag, gc, ...) on this registry.
    collectDefaultMetrics({ register: this.registry });

    this.requestsTotal = new Counter({
      name: 'http_requests_total',
      help: 'Total number of HTTP requests, labelled by request method and response status code.',
      labelNames: [ 'method', 'code' ],
      registers: [ this.registry ],
    });

    this.requestDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'Duration of HTTP requests in seconds, labelled by request method and response status code.',
      labelNames: [ 'method', 'code' ],
      registers: [ this.registry ],
    });

    this.notificationDeliveriesTotal = new Counter({
      name: 'css_notification_deliveries_total',
      help: 'Total number of notification delivery attempts, labelled by channel type and delivery outcome.',
      labelNames: [ 'type', 'outcome' ],
      registers: [ this.registry ],
    });
  }
}
