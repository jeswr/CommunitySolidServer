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
 * ACL and shape documents are usually only a few KiB, so this leaves generous headroom.
 */
export const DEFAULT_MAX_VALIDATION_SIZE = 4 * 1024 * 1024;

/**
 * Validates a Representation by verifying if the data stream contains valid RDF data.
 * It does this by letting the stored RepresentationConverter convert the data.
 *
 * Validation buffers the entire data stream in memory,
 * so streams exceeding `maxSize` bytes are rejected with a 413 error before being fully buffered.
 */
export class RdfValidator extends Validator {
  protected readonly converter: RepresentationConverter;
  protected readonly maxSize: number;

  /**
   * @param converter - Used to convert the data stream to RDF quads to verify it is valid.
   * @param maxSize - The maximum number of bytes a document may contain before validation rejects it.
   *                  0 or a negative value disables the check. Defaults to {@link DEFAULT_MAX_VALIDATION_SIZE}.
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
      // Reject oversized documents before cloneRepresentation buffers the entire stream in memory
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
   * once more than `maxSize` bytes have passed through it.
   *
   * @param data - The data stream to guard.
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
