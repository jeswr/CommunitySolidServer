import { getLoggerFor } from '../../../logging/LogUtil';
import { TooManyRequestsHttpError } from '../../../util/errors/TooManyRequestsHttpError';
import { SOLID_HTTP } from '../../../util/Vocabularies';
import type { JsonRepresentation } from '../InteractionUtil';
import type { JsonInteractionHandlerInput } from '../JsonInteractionHandler';
import { JsonInteractionHandler } from '../JsonInteractionHandler';
import type { JsonView } from '../JsonView';
import type { RateLimiter } from './RateLimiter';

export interface RateLimitHandlerArgs {
  /**
   * The handler that will be called when the request is within the rate limit.
   */
  source: JsonInteractionHandler & JsonView;
  /**
   * The rate limiter tracking how many attempts each key made.
   * Each handler should use a dedicated limiter so different endpoints have independent counters.
   */
  limiter: RateLimiter;
  /**
   * Whether the rate limiter is enabled.
   * When set to `false`, all requests are passed through to the source handler unchanged.
   */
  enabled?: boolean;
  /**
   * If `true`, a successful action resets the counter for its key and only failed attempts are counted.
   * This is used for login, so that failed password attempts are limited
   * while a legitimate user is never locked out mid-session.
   * If `false` (the default), every completed action is counted,
   * which is used for account creation and password-reset requests.
   */
  resetOnSuccess?: boolean;
}

/**
 * A {@link JsonInteractionHandler} that rate-limits the POST actions of the handler it wraps,
 * returning a 429 {@link TooManyRequestsHttpError} once the limit for a key is exceeded.
 *
 * The key is derived from the client IP (added to the metadata by a `ClientIpParser`)
 * combined with the target account (the `email` field of the body) when one is present.
 * This keeps different clients and different accounts independent of each other.
 *
 * GET requests (the views/forms) are always passed through and never counted,
 * as only the submissions are potential abuse vectors.
 * This handler is designed to be placed as the `source` of a {@link ViewInteractionHandler}.
 */
export class RateLimitHandler extends JsonInteractionHandler implements JsonView {
  protected readonly logger = getLoggerFor(this);

  private readonly source: JsonInteractionHandler & JsonView;
  private readonly limiter: RateLimiter;
  private readonly enabled: boolean;
  private readonly resetOnSuccess: boolean;

  public constructor(args: RateLimitHandlerArgs) {
    super();
    this.source = args.source;
    this.limiter = args.limiter;
    this.enabled = args.enabled ?? true;
    this.resetOnSuccess = args.resetOnSuccess ?? false;
  }

  public async getView(input: JsonInteractionHandlerInput): Promise<JsonRepresentation> {
    return this.source.getView(input);
  }

  public async canHandle(input: JsonInteractionHandlerInput): Promise<void> {
    await this.source.canHandle(input);
  }

  public async handle(input: JsonInteractionHandlerInput): Promise<JsonRepresentation> {
    if (!this.enabled) {
      return this.source.handle(input);
    }

    const key = this.getKey(input);
    if (!this.limiter.isAllowed(key)) {
      this.logger.warn(`Rate limit exceeded for ${key}`);
      throw new TooManyRequestsHttpError('Too many requests, please try again later.');
    }

    let result: JsonRepresentation;
    try {
      result = await this.source.handle(input);
    } catch (error: unknown) {
      // Count the failed attempt (e.g. an incorrect password) against the limit.
      this.limiter.increment(key);
      throw error;
    }

    if (this.resetOnSuccess) {
      // A successful action (e.g. a correct login) clears the counter so the client is not locked out.
      this.limiter.reset(key);
    } else {
      // Every completed action counts (e.g. account creation or a password-reset mail).
      this.limiter.increment(key);
    }
    return result;
  }

  /**
   * Builds the rate-limit key for the given request from the client IP and, when present, the target account.
   *
   * @param input - The handler input.
   *
   * @returns The key to use for the limiter.
   */
  private getKey(input: JsonInteractionHandlerInput): string {
    const ip = input.metadata.get(SOLID_HTTP.terms.clientIp)?.value ?? 'unknown';
    const target = this.extractTarget(input.json);
    return target ? `${ip}:${target}` : ip;
  }

  /**
   * Extracts the target account identifier (the `email` field) from the request body, if any.
   *
   * @param json - The JSON body of the request.
   *
   * @returns The lower-cased email, or `undefined` if none is present.
   */
  private extractTarget(json: unknown): string | undefined {
    if (typeof json !== 'object' || json === null) {
      return undefined;
    }
    const value = (json as Record<string, unknown>).email;
    if (typeof value === 'string' && value.length > 0) {
      return value.toLowerCase();
    }
    return undefined;
  }
}
