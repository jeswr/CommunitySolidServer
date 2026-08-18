import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { getLoggerFor } from '../../logging/LogUtil';
import { createErrorMessage } from '../../util/errors/ErrorUtil';
import { ServerConfigurator } from '../ServerConfigurator';
import type { PrometheusMetrics } from './PrometheusMetrics';

/**
 * A {@link ServerConfigurator} that attaches an observe-only listener to the `request` event of a
 * {@link Server}, recording the request count and duration, labelled by method and status code,
 * once the response finishes. The listener never writes to the response,
 * and errors are caught and logged, so a metrics failure can never break request handling.
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
