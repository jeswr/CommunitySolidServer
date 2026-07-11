import { getLoggerFor } from '../../logging/LogUtil';
import { APPLICATION_JSON } from '../../util/ContentTypes';
import { NotImplementedHttpError } from '../../util/errors/NotImplementedHttpError';
import type { HttpHandlerInput } from '../HttpHandler';
import { HttpHandler } from '../HttpHandler';

/**
 * Handler that responds to liveness requests on a fixed URL path.
 * A 200 response only indicates that the server process is up and able to answer HTTP requests;
 * no backend storage is verified.
 */
export class HealthHandler extends HttpHandler {
  private readonly path: string;
  private readonly logger = getLoggerFor(this);

  /**
   * @param path - The URL path on which to respond to health requests.
   */
  public constructor(path = '/.well-known/css/health') {
    super();
    this.path = path;
  }

  public async canHandle({ request }: HttpHandlerInput): Promise<void> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      throw new NotImplementedHttpError('Only GET and HEAD requests are supported');
    }
    // Ignore the query string when comparing paths
    const path = (request.url ?? '').split('?')[0];
    if (path !== this.path) {
      throw new NotImplementedHttpError(`Only requests to ${this.path} are supported`);
    }
  }

  public async handle({ request, response }: HttpHandlerInput): Promise<void> {
    this.logger.debug(`Responding to health request on ${request.url}`);
    response.writeHead(200, {
      // eslint-disable-next-line @typescript-eslint/naming-convention
      'content-type': APPLICATION_JSON,
      // eslint-disable-next-line @typescript-eslint/naming-convention
      'cache-control': 'no-store',
    });

    if (request.method === 'HEAD') {
      response.end();
    } else {
      response.end(JSON.stringify({ status: 'ok' }));
    }
  }
}
