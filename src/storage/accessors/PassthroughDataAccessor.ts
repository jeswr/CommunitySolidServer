import type { Readable } from 'node:stream';
import type { Representation } from '../../http/representation/Representation';
import type { RepresentationMetadata } from '../../http/representation/RepresentationMetadata';
import type { ResourceIdentifier } from '../../http/representation/ResourceIdentifier';
import type { Guarded } from '../../util/GuardedStream';
import type { ResourceStorageHints } from '../ResourceSet';
import type { AtomicDataAccessor } from './AtomicDataAccessor';
import type { DataAccessor, WriteDocumentOptions } from './DataAccessor';

/**
 * DataAccessor that calls the corresponding functions of the source DataAccessor.
 * Can be extended by data accessors that do not want to override all functions
 * by implementing a decorator pattern.
 */
export class PassthroughDataAccessor implements DataAccessor {
  protected readonly accessor: AtomicDataAccessor;

  public constructor(accessor: DataAccessor) {
    this.accessor = accessor;
  }

  public async writeDocument(
    identifier: ResourceIdentifier,
    data: Guarded<Readable>,
    metadata: RepresentationMetadata,
    options?: WriteDocumentOptions,
  ):
  Promise<void> {
    return options ?
        this.accessor.writeDocument(identifier, data, metadata, options) :
        this.accessor.writeDocument(identifier, data, metadata);
  }

  public async writeContainer(identifier: ResourceIdentifier, metadata: RepresentationMetadata): Promise<void> {
    return this.accessor.writeContainer(identifier, metadata);
  }

  public async canHandle(representation: Representation): Promise<void> {
    return this.accessor.canHandle(representation);
  }

  public async getData(identifier: ResourceIdentifier, hints?: ResourceStorageHints): Promise<Guarded<Readable>> {
    return hints ? this.accessor.getData(identifier, hints) : this.accessor.getData(identifier);
  }

  public async getMetadata(identifier: ResourceIdentifier, hints?: ResourceStorageHints):
  Promise<RepresentationMetadata> {
    return hints ? this.accessor.getMetadata(identifier, hints) : this.accessor.getMetadata(identifier);
  }

  public async writeMetadata(identifier: ResourceIdentifier, metadata: RepresentationMetadata): Promise<void> {
    return this.accessor.writeMetadata(identifier, metadata);
  }

  public getChildren(identifier: ResourceIdentifier): AsyncIterableIterator<RepresentationMetadata> {
    return this.accessor.getChildren(identifier);
  }

  public async deleteResource(identifier: ResourceIdentifier, hints?: ResourceStorageHints): Promise<void> {
    return hints ? this.accessor.deleteResource(identifier, hints) : this.accessor.deleteResource(identifier);
  }
}
