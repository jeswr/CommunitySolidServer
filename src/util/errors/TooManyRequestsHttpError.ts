import type { HttpErrorOptions } from './HttpError';
import { generateHttpErrorClass } from './HttpError';

// eslint-disable-next-line @typescript-eslint/naming-convention
const BaseHttpError = generateHttpErrorClass(429, 'TooManyRequestsHttpError');

/**
 * An error thrown when a client sent too many requests in a given amount of time.
 */
export class TooManyRequestsHttpError extends BaseHttpError {
  /**
   * Default message is 'Too many requests.'.
   *
   * @param message - Optional, more specific, message.
   * @param options - Optional error options.
   */
  public constructor(message?: string, options?: HttpErrorOptions) {
    super(message ?? 'Too many requests.', options);
  }
}
