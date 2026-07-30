import type { TargetExtractor } from '../../http/input/identifier/TargetExtractor';
import { BadRequestHttpError } from '../../util/errors/BadRequestHttpError';
import type { HttpHandler, HttpHandlerInput } from '../HttpHandler';
import { BaseRouterHandler } from '../util/BaseRouterHandler';
import { HeaderHandler } from './HeaderHandler';

export interface PathHeaderHandlerArgs {
  /**
   * Extracts the target to match against `allowedPathNames`.
   */
  targetExtractor: TargetExtractor;
  /**
   * The base URL of the server.
   */
  baseUrl: string;
  /**
   * Constant headers to set on matching requests.
   */
  headers: Record<string, string>;
  /**
   * The allowed method(s). Default is `[ '*' ]`.
   */
  allowedMethods?: string[];
  /**
   * Regular expression(s) used to match the target URL.
   */
  allowedPathNames?: string[];
}

/**
 * A {@link HeaderHandler} that only sets its headers when the target matches the configured method(s) and path(s).
 * Uses a {@link TargetExtractor} to generate the target identifier.
 */
export class PathHeaderHandler extends BaseRouterHandler<HttpHandler> {
  private readonly targetExtractor: TargetExtractor;

  public constructor(args: PathHeaderHandlerArgs) {
    super({
      baseUrl: args.baseUrl,
      handler: new HeaderHandler(args.headers),
      allowedMethods: args.allowedMethods,
      allowedPathNames: args.allowedPathNames,
    });
    this.targetExtractor = args.targetExtractor;
  }

  public async canHandle(input: HttpHandlerInput): Promise<void> {
    const { request } = input;
    if (!request.url) {
      throw new BadRequestHttpError('Cannot handle request without a url');
    }
    const target = await this.targetExtractor.handleSafe({ request });
    await super.canHandleInput(input, request.method ?? 'UNKNOWN', target);
  }
}
