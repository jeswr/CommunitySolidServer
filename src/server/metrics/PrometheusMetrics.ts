import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';

/**
 * Creates a Prometheus {@link Registry} collecting the default process metrics,
 * together with the instruments used to observe incoming HTTP requests.
 * These are only labelled by request `method` and response status `code`:
 * a label on the request path would cause a cardinality explosion, since every resource URL is distinct.
 */
export class PrometheusMetrics {
  public readonly registry: Registry;
  public readonly requestsTotal: Counter<'code' | 'method'>;
  public readonly requestDuration: Histogram<'code' | 'method'>;

  public constructor() {
    this.registry = new Registry();
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
  }
}
