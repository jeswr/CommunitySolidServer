import type { HttpError, HttpErrorClass } from '../errors/HttpError';
import { AsyncHandler } from './AsyncHandler';

/**
 * Utility handler that can handle all input and always throws an instance of the given error.
 */
export class StaticThrowHandler extends AsyncHandler<unknown, never> {
  protected readonly errorClass: HttpErrorClass;

  public constructor(error: HttpError) {
    super();
    // Only the error's class is retained, never the provided instance.
    // `handle` always throws a fresh instance, so the instance itself is unused after construction.
    // Retaining it would also retain its lazily-formatted V8 stack trace; as this handler is
    // instantiated by Components.js, that stack captures the configuration-construction call frames
    // and would keep the entire parsed configuration object graph alive for the server's lifetime.
    this.errorClass = error.constructor as HttpErrorClass;
  }

  public async handle(): Promise<never> {
    // We are creating a new instance of the error instead of rethrowing the error,
    // as reusing the same error can cause problem as the metadata is then also reused.
    // eslint-disable-next-line new-cap
    throw new this.errorClass();
  }
}
