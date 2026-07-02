import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { getLoggerFor } from '../../logging/LogUtil';
import { createErrorMessage } from '../../util/errors/ErrorUtil';
import { ServerConfigurator } from '../ServerConfigurator';
import type { PrometheusMetrics } from './PrometheusMetrics';

/**
 * A {@link ServerConfigurator} that attaches an observe-only listener to the `request` event of a
 * {@link Server} to record Prometheus metrics.
 *
 * The listener runs alongside the main request listener without interfering with it:
 * it never writes to the response, never consumes the request body,
 * and never throws into the request flow.
 * Any error while instrumenting or recording is caught and logged so that a metrics failure
 * can never break request handling.
 *
 * On every request a timer is started; when the response emits `finish` the duration is observed and
 * the request counter is incremented with the request method and the response status code.
 */
export class MetricsServerConfigurator extends ServerConfigurator {
  protected readonly logger = getLoggerFor(this);

  private readonly metrics: PrometheusMetrics;

  /**
   * @param metrics - The {@link PrometheusMetrics} holding the registry and request instruments.
   */
  public constructor(metrics: PrometheusMetrics) {
    super();
    this.metrics = metrics;
  }

  public async handle(server: Server): Promise<void> {
    server.on('request', (request: IncomingMessage, response: ServerResponse): void => {
      try {
        // Start timing before the request is handled; the returned function observes the duration.
        const stopTimer = this.metrics.requestDuration.startTimer();
        response.on('finish', (): void => {
          try {
            const labels = { method: request.method ?? 'UNKNOWN', code: response.statusCode };
            this.metrics.requestsTotal.inc(labels);
            stopTimer(labels);
          } catch (error: unknown) {
            this.logger.error(`Unable to record request metrics: ${createErrorMessage(error)}`);
          }
        });
      } catch (error: unknown) {
        this.logger.error(`Unable to instrument request for metrics: ${createErrorMessage(error)}`);
      }
    });
  }
}
