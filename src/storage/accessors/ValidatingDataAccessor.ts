import type { Readable } from 'node:stream';
import type { Validator } from '../../http/auxiliary/Validator';
import { BasicRepresentation } from '../../http/representation/BasicRepresentation';
import type { RepresentationMetadata } from '../../http/representation/RepresentationMetadata';
import type { ResourceIdentifier } from '../../http/representation/ResourceIdentifier';
import type { Guarded } from '../../util/GuardedStream';
import { serializeQuads } from '../../util/QuadUtil';
import { readableToString } from '../../util/StreamUtil';
import type { DataAccessor } from './DataAccessor';
import { PassthroughDataAccessor } from './PassthroughDataAccessor';

/**
 * A ValidatingDataAccessor wraps a DataAccessor such that the data stream is validated while being written.
 * An AtomicDataAccessor can be used to prevent data being written in case validation fails.
 */
export class ValidatingDataAccessor extends PassthroughDataAccessor {
  private readonly validator: Validator;

  public constructor(accessor: DataAccessor, validator: Validator) {
    super(accessor);
    this.validator = validator;
  }

  public async writeDocument(
    identifier: ResourceIdentifier,
    data: Guarded<Readable>,
    metadata: RepresentationMetadata,
  ): Promise<void> {
    const pipedRep = await this.validator.handleSafe({
      representation: new BasicRepresentation(data, metadata),
      identifier,
    });
    return this.accessor.writeDocument(identifier, pipedRep.data, metadata);
  }

  public async writeContainer(identifier: ResourceIdentifier, metadata: RepresentationMetadata): Promise<void> {
    // A container's data mainly resides in its metadata,
    // of which we can't calculate the disk size of at this point in the code.
    // Extra info can be found here: https://github.com/CommunitySolidServer/CommunitySolidServer/pull/973#discussion_r723376888
    return this.accessor.writeContainer(identifier, metadata);
  }

  /**
   * Metadata (`.meta` sidecars) is persisted as a serialized stream of quads.
   * Without this override the write would bypass the validator entirely, letting a large metadata
   * document exceed the configured quota. The serialized metadata is therefore run through the same
   * validator used for documents so its size counts against the quota. Because the wrapped accessor
   * re-serializes the metadata itself, the validated stream is fully consumed here purely to drive the
   * quota guard, which rejects (413) when the write would exceed the available space.
   *
   * When quota is not configured this accessor is not instantiated, so this method is never invoked
   * and metadata writes keep their original behavior.
   */
  public async writeMetadata(identifier: ResourceIdentifier, metadata: RepresentationMetadata): Promise<void> {
    const pipedRep = await this.validator.handleSafe({
      representation: new BasicRepresentation(serializeQuads(metadata.quads()), metadata),
      identifier,
    });
    // Draining the validated stream triggers the quota guard, which errors when quota would be exceeded.
    await readableToString(pipedRep.data);
    return this.accessor.writeMetadata(identifier, metadata);
  }
}
