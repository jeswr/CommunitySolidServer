import type { Readable, TransformCallback } from 'node:stream';
import { PassThrough } from 'node:stream';
import type { HttpRequest } from '../server/HttpRequest';
import { PayloadHttpError } from './errors/PayloadHttpError';
import type { Guarded } from './GuardedStream';
import { pipeSafely } from './StreamUtil';

/**
 * Limits the amount of data that can be read from the body of the given request.
 * If the request has a Content-Length header whose value exceeds the given limit,
 * a {@link PayloadHttpError} will be thrown immediately, before reading the body.
 * Otherwise, the body will be piped through a new stream
 * that emits a {@link PayloadHttpError} as soon as more than `maxSize` bytes have been read.
 * The request will be returned unchanged if no limit is defined,
 * so in that case behaviour is identical to not calling this function at all.
 *
 * @param request - The request whose body size needs to be limited.
 * @param maxSize - The maximum allowed body size in bytes. If undefined, there is no limit.
 *
 * @returns A stream that errors when more than `maxSize` bytes would be read from it.
 */
export function limitBodySize(request: HttpRequest, maxSize?: number): Guarded<Readable> {
  if (typeof maxSize !== 'number') {
    return request;
  }

  // Fail fast if the client already announced a body that is too large.
  // Invalid Content-Length values result in `NaN` and are ignored here,
  // in which case the size of the actual data is still being checked below.
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
