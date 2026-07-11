import type { NamedNode } from '@rdfjs/types';
import { RepresentationMetadata } from '../../http/representation/RepresentationMetadata';
import { toLiteral, toNamedTerm } from '../TermUtil';
import { HTTP, SOLID_ERROR, XSD } from '../Vocabularies';
import { isError } from './ErrorUtil';

export interface HttpErrorOptions {
  cause?: unknown;
  errorCode?: string;
  metadata?: RepresentationMetadata;
}

/**
 * Returns a URI that is unique for the given status code.
 */
export function generateHttpErrorUri(statusCode: number): NamedNode {
  return toNamedTerm(`${SOLID_ERROR.namespace}H${statusCode}`);
}

/**
 * A class for all errors that could be thrown by Solid.
 * All errors inheriting from this should fix the status code thereby hiding the HTTP internals from other components.
 */
export class HttpError<T extends number = number> extends Error implements HttpErrorOptions {
  /**
   * Determines whether stack traces are captured when constructing errors that are used for control flow,
   * which covers all errors with a status code below 500, and the 501 status code.
   * Such errors get thrown constantly while checking which handler in a chain supports a request,
   * so capturing their stack traces is expensive while the result is almost never used.
   * Server errors always capture a stack trace, as those indicate bugs and get logged.
   * When capturing is disabled, the `stack` field still contains the `Name: message` line, but no stack frames.
   */
  public static captureStackTraces = false;

  public readonly statusCode: T;
  public readonly cause?: unknown;
  public readonly errorCode: string;
  public readonly metadata: RepresentationMetadata;

  /**
   * Creates a new HTTP error. Subclasses should call this with their fixed status code.
   *
   * @param statusCode - HTTP status code needed for the HTTP response.
   * @param name - Error name. Useful for logging and stack tracing.
   * @param message - Error message.
   * @param options - Optional options.
   */
  public constructor(statusCode: T, name: string, message?: string, options: HttpErrorOptions = {}) {
    // Setting `Error.stackTraceLimit` to 0 makes the `Error` constructor skip the expensive stack trace capture
    const previousLimit = Error.stackTraceLimit;
    if (!HttpError.captureStackTraces && (statusCode < 500 || statusCode === 501)) {
      Error.stackTraceLimit = 0;
    }
    super(message);
    Error.stackTraceLimit = previousLimit;
    this.statusCode = statusCode;
    this.name = name;
    this.cause = options.cause;
    this.errorCode = options.errorCode ?? `H${statusCode}`;
    this.metadata = options.metadata ?? new RepresentationMetadata();
    this.generateMetadata();
  }

  public static isInstance(error: unknown): error is HttpError {
    return isError(error) &&
      typeof (error as HttpError).statusCode === 'number' &&
      Boolean((error as HttpError).metadata);
  }

  /**
   * Initializes the error metadata.
   */
  protected generateMetadata(): void {
    this.metadata.add(SOLID_ERROR.terms.errorResponse, generateHttpErrorUri(this.statusCode));
    this.metadata.add(HTTP.terms.statusCodeNumber, toLiteral(this.statusCode, XSD.terms.integer));
  }
}

/**
 * Interface describing what an HttpError class should look like.
 * This helps us make sure all HttpError classes have the same utility static functions.
 */
export interface HttpErrorClass<TCode extends number = number> {
  new(message?: string, options?: HttpErrorOptions): HttpError<TCode>;

  /**
   * The status code corresponding to this error class.
   */
  readonly statusCode: TCode;
  /**
   * A unique URI identifying this error class.
   */
  readonly uri: NamedNode;
  /**
   * Checks whether the given error is an instance of this class.
   */
  readonly isInstance: (error: unknown) => error is HttpError<TCode>;
}

/**
 * Generates a new HttpError class with the given status code and name.
 * In general, status codes are used to uniquely identify error types,
 * so there should be no 2 classes with the same value there.
 *
 * To make sure Components.js can work with these newly generated classes,
 * the generated class should be called `BaseHttpError` as that name is an entry in `.componentsignore`.
 * The actual class should then extend `BaseHttpError` and have a correct constructor,
 * so the Components.js generator can generate the correct components JSON-LD file during build.
 */
export function generateHttpErrorClass<TCode extends number>(statusCode: TCode, name: string): HttpErrorClass<TCode> {
  return class SpecificHttpError extends HttpError<TCode> {
    public static readonly statusCode = statusCode;
    public static readonly uri = generateHttpErrorUri(statusCode);

    public constructor(message?: string, options?: HttpErrorOptions) {
      super(statusCode, name, message, options);
    }

    public static isInstance(error: unknown): error is SpecificHttpError {
      return HttpError.isInstance(error) && error.statusCode === statusCode;
    }
  };
}
