import type { Readable, TransformCallback } from 'node:stream';
import { PassThrough } from 'node:stream';
import type { HttpRequest } from '../server/HttpRequest';
import { PayloadHttpError } from './errors/PayloadHttpError';
import type { Guarded } from './GuardedStream';
import { pipeSafely } from './StreamUtil';

/**
 * Limits the amount of data that can be read from the body of the given request.
 * If the Content-Length header exceeds the given limit, an error is thrown before reading the body;
 * otherwise the body is piped through a stream that errors once more than `maxSize` bytes have been read.
 * If no limit is defined, the request is returned unchanged.
 *
 * @param request - The request whose body size needs to be limited.
 * @param maxSize - The maximum allowed body size in bytes. If undefined, there is no limit.
 *
 * @returns A stream that errors with a {@link PayloadHttpError} when more than `maxSize` bytes would be read.
 */
export function limitBodySize(request: HttpRequest, maxSize?: number): Guarded<Readable> {
  if (typeof maxSize !== 'number') {
    return request;
  }

  // Fail fast if the client already announced a body that is too large.
  // An invalid Content-Length parses to `NaN` and is ignored here; the actual data size is still checked below.
  const contentLength = Number.parseInt(request.headers['content-length'] ?? '', 10);
  if (contentLength > maxSize) {
    throw new PayloadHttpError(
      `The Content-Length header of ${contentLength} exceeds the maximum allowed body size of ${maxSize} bytes.`,
    );
  }

  let total = 0;
  const guard = new PassThrough({
    transform(chunk: Buffer, encoding: BufferEncoding, done: TransformCallback): void {
      total += chunk.length;
      if (total > maxSize) {
        done(new PayloadHttpError(`The body exceeds the maximum allowed body size of ${maxSize} bytes.`));
      } else {
        done(null, chunk);
      }
    },
  });
  return pipeSafely(request, guard);
}
