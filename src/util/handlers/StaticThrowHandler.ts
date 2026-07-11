import type { HttpError, HttpErrorClass } from '../errors/HttpError';
import { AsyncHandler } from './AsyncHandler';

/**
 * Utility handler that can handle all input and always throws an instance of the given error.
 */
export class StaticThrowHandler extends AsyncHandler<unknown, never> {
  protected readonly errorClass: HttpErrorClass;

  public constructor(error: HttpError) {
    super();
    // Keeping the instance would retain its captured stack trace,
    // which pins the entire Components.js configuration graph that constructed this handler.
    this.errorClass = error.constructor as HttpErrorClass;
  }

  public async handle(): Promise<never> {
    // We are creating a new instance of the error instead of rethrowing the error,
    // as reusing the same error can cause problem as the metadata is then also reused.
    // eslint-disable-next-line new-cap
    throw new this.errorClass();
  }
}
