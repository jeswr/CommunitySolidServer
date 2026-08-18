import { NotImplementedHttpError } from '../../util/errors/NotImplementedHttpError';
import type { HttpHandlerInput } from '../HttpHandler';
import { HttpHandler } from '../HttpHandler';
import type { PrometheusMetrics } from './PrometheusMetrics';

/**
 * An {@link HttpHandler} that serves the collected Prometheus metrics on a fixed path (default `/metrics`).
 * Only `GET` requests on that path are handled.
 * The response is unauthenticated and exposes internal counters:
 * restrict access to this endpoint at the reverse proxy or firewall.
 */
export class MetricsHandler extends HttpHandler {
  private readonly metrics: PrometheusMetrics;
  private readonly path: string;

  /**
   * @param metrics - The {@link PrometheusMetrics} exposing the registry to serialize.
   * @param path - The path on which the metrics are exposed. Defaults to `/metrics`.
   */
  public constructor(metrics: PrometheusMetrics, path = '/metrics') {
    super();
    this.metrics = metrics;
    this.path = path;
  }

  public async canHandle({ request }: HttpHandlerInput): Promise<void> {
    if (request.method !== 'GET') {
      throw new NotImplementedHttpError('Only GET requests are supported');
    }
    if (request.url?.split('?')[0] !== this.path) {
      throw new NotImplementedHttpError(`Only ${this.path} is supported`);
    }
  }

  public async handle({ response }: HttpHandlerInput): Promise<void> {
    const { registry } = this.metrics;
    const body = await registry.metrics();
    response.writeHead(200, {
      // eslint-disable-next-line @typescript-eslint/naming-convention
      'content-type': registry.contentType,
    });
    response.end(body);
  }
}
