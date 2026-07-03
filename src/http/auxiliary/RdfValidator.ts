import type { Readable, Transform } from 'node:stream';
import arrayifyStream from 'arrayify-stream';
import type { RepresentationConverter } from '../../storage/conversion/RepresentationConverter';
import { INTERNAL_QUADS } from '../../util/ContentTypes';
import { PayloadHttpError } from '../../util/errors/PayloadHttpError';
import type { Guarded } from '../../util/GuardedStream';
import { cloneRepresentation } from '../../util/ResourceUtil';
import { transformSafely } from '../../util/StreamUtil';
import type { Representation } from '../representation/Representation';
import type { ValidatorInput } from './Validator';
import { Validator } from './Validator';

/**
 * The default maximum number of bytes {@link RdfValidator} buffers while validating a document.
 * Set very generously (several MiB) as ACL and shape documents are normally only a few KiB,
 * so legitimate documents will never reach this value.
 */
export const DEFAULT_MAX_VALIDATION_SIZE = 4 * 1024 * 1024;

/**
 * Validates a Representation by verifying if the data stream contains valid RDF data.
 * It does this by letting the stored RepresentationConverter convert the data.
 *
 * Validating RDF requires the entire graph, so the data stream is fully buffered in memory during validation.
 * An oversized document is therefore an (authenticated) memory-based denial-of-service vector.
 * To prevent this, the data stream is aborted with a 413 {@link PayloadHttpError}
 * as soon as it exceeds `maxSize` bytes, before the whole document is buffered.
 */
export class RdfValidator extends Validator {
  protected readonly converter: RepresentationConverter;
  protected readonly maxSize: number;

  /**
   * @param converter - Used to convert the data stream to RDF quads to verify it is valid.
   * @param maxSize - The maximum number of bytes a document may contain before validation rejects it.
   *                  Set to 0 (or a negative value) to disable the check and allow documents of unlimited size.
   *                  Defaults to {@link DEFAULT_MAX_VALIDATION_SIZE}.
   */
  public constructor(converter: RepresentationConverter, maxSize = DEFAULT_MAX_VALIDATION_SIZE) {
    super();
    this.converter = converter;
    this.maxSize = maxSize;
  }

  public async handle({ representation, identifier }: ValidatorInput): Promise<Representation> {
    // If the data already is quads format we know it's RDF
    if (representation.metadata.contentType === INTERNAL_QUADS) {
      return representation;
    }
    const preferences = { type: { [INTERNAL_QUADS]: 1 }};
    let result;
    try {
      // Validating RDF needs the full graph, so `cloneRepresentation` below buffers the whole stream in memory.
      // Guard against oversized documents by aborting the stream once it passes the configured limit,
      // so a pathologically large document is rejected before it is fully buffered.
      if (this.maxSize > 0) {
        representation.data = this.guardSize(representation.data);
      }
      // Creating new representation since converter might edit metadata
      const tempRepresentation = await cloneRepresentation(representation);
      result = await this.converter.handleSafe({
        identifier,
        representation: tempRepresentation,
        preferences,
      });
    } catch (error: unknown) {
      representation.data.destroy();
      throw error;
    }
    // Drain stream to make sure data was parsed correctly
    await arrayifyStream(result.data);

    return representation;
  }

  /**
   * Wraps the given data stream so it errors with a 413 {@link PayloadHttpError}
   * as soon as more than `maxSize` bytes have passed through it.
   * The data itself is left unchanged, so documents that stay within the limit are unaffected.
   *
   * @param data - The data stream to guard.
   *
   * @returns A stream emitting the same data that aborts once the size limit is exceeded.
   */
  private guardSize(data: Guarded<Readable>): Guarded<Transform> {
    const { maxSize } = this;
    let size = 0;
    return transformSafely<Buffer | string>(data, {
      transform(this: Transform, chunk: Buffer | string): void {
        size += Buffer.byteLength(chunk);
        if (size > maxSize) {
          throw new PayloadHttpError(`Data exceeds the maximum size of ${maxSize} bytes allowed for RDF validation.`);
        }
        this.push(chunk);
      },
    });
  }
}
