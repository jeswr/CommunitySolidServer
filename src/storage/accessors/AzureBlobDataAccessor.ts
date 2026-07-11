import type { Readable } from 'node:stream';
import { BlobServiceClient, RestError } from '@azure/storage-blob';
import type { BlobDownloadResponseParsed, ContainerClient } from '@azure/storage-blob';
import type { Representation } from '../../http/representation/Representation';
import { RepresentationMetadata } from '../../http/representation/RepresentationMetadata';
import type { ResourceIdentifier } from '../../http/representation/ResourceIdentifier';
import { getLoggerFor } from '../../logging/LogUtil';
import { TEXT_TURTLE } from '../../util/ContentTypes';
import { createErrorMessage } from '../../util/errors/ErrorUtil';
import { NotFoundHttpError } from '../../util/errors/NotFoundHttpError';
import { UnsupportedMediaTypeHttpError } from '../../util/errors/UnsupportedMediaTypeHttpError';
import { guardStream } from '../../util/GuardedStream';
import type { Guarded } from '../../util/GuardedStream';
import type { IdentifierStrategy } from '../../util/identifiers/IdentifierStrategy';
import { isContainerIdentifier } from '../../util/PathUtil';
import { parseQuads, serializeQuads } from '../../util/QuadUtil';
import { addResourceMetadata, updateModifiedDate } from '../../util/ResourceUtil';
import { toLiteral } from '../../util/TermUtil';
import { CONTENT_TYPE_TERM, DC, LDP, POSIX, RDF, SOLID_META, XSD } from '../../util/Vocabularies';
import type { DataAccessor } from './DataAccessor';

/**
 * The suffix used for metadata companion blobs.
 * The metadata strategy blocks writes to identifiers with this suffix,
 * so companion blobs can never collide with user resources.
 */
const METADATA_SUFFIX = '.meta';

/**
 * The subset of the properties returned by Azure Blob Storage that is used to generate metadata.
 */
interface AzureBlobProperties {
  contentType?: string;
  contentLength?: number;
  lastModified?: Date;
}

/**
 * DataAccessor that stores documents and containers as blobs in an Azure Blob Storage container.
 *
 * Blob keys are the full resource URLs, so `listBlobsByHierarchy` with a `/` delimiter can be used for listings.
 * Containers are stored as empty marker blobs whose key is the container URL itself,
 * so empty containers remain visible.
 * Additional metadata of a resource is stored in a companion blob with the `.meta` suffix appended to its key.
 *
 * Note that this is not an {@link AtomicDataAccessor}, as blobs are overwritten in place,
 * so it cannot be wrapped by accessors requiring atomicity, such as the {@link ValidatingDataAccessor}.
 */
export class AzureBlobDataAccessor implements DataAccessor {
  protected readonly logger = getLoggerFor(this);

  private readonly containerClient: ContainerClient;
  private readonly identifierStrategy: IdentifierStrategy;

  /**
   * @param connectionString - Connection string of the Azure Storage account.
   * @param containerName - Name of the Azure Blob Storage container in which all blobs will be stored.
   * @param identifierStrategy - Strategy for interpreting the identifiers.
   */
  public constructor(connectionString: string, containerName: string, identifierStrategy: IdentifierStrategy) {
    this.containerClient = BlobServiceClient.fromConnectionString(connectionString)
      .getContainerClient(containerName);
    this.identifierStrategy = identifierStrategy;
  }

  /**
   * Only binary data can be stored as blobs so will error on non-binary data.
   */
  public async canHandle(representation: Representation): Promise<void> {
    if (!representation.binary) {
      throw new UnsupportedMediaTypeHttpError('Only binary data is supported.');
    }
  }

  /**
   * Returns the data stream of the blob corresponding to the resource.
   * Will throw a NotFoundHttpError if the input is a container.
   */
  public async getData(identifier: ResourceIdentifier): Promise<Guarded<Readable>> {
    if (isContainerIdentifier(identifier)) {
      throw new NotFoundHttpError();
    }
    const response = await this.downloadBlob(this.getBlobKey(identifier));
    return guardStream(response.readableStreamBody as Readable);
  }

  /**
   * Will return the corresponding metadata by reading the metadata companion blob (if it exists)
   * and adding blob-specific metadata elements generated from the blob properties.
   */
  public async getMetadata(identifier: ResourceIdentifier): Promise<RepresentationMetadata> {
    const properties = await this.getBlobProperties(this.getBlobKey(identifier));
    const isContainer = isContainerIdentifier(identifier);

    const metadata = await this.getRawMetadata(identifier);
    addResourceMetadata(metadata, isContainer);
    this.addBlobMetadata(metadata, properties, isContainer);
    // Containers will not have a content-type
    if (!isContainer) {
      metadata.set(CONTENT_TYPE_TERM, properties.contentType);
    }
    return metadata;
  }

  public async* getChildren(identifier: ResourceIdentifier): AsyncIterableIterator<RepresentationMetadata> {
    // Documents have no children
    if (!isContainerIdentifier(identifier)) {
      return;
    }
    const prefix = this.getBlobKey(identifier);
    for await (const child of this.containerClient.listBlobsByHierarchy('/', { prefix })) {
      if (child.kind === 'prefix') {
        // Blob prefixes correspond to child containers and already have a trailing slash
        const metadata = new RepresentationMetadata({ path: child.name });
        addResourceMetadata(metadata, true);
        yield metadata;
      } else if (!child.name.endsWith('/') && !AzureBlobDataAccessor.isMetadataKey(child.name)) {
        // Blob items correspond to child documents,
        // excluding container marker blobs and metadata companion blobs
        const metadata = new RepresentationMetadata({ path: child.name });
        addResourceMetadata(metadata, false);
        this.addBlobMetadata(metadata, child.properties, false);
        yield metadata;
      }
    }
  }

  /**
   * Writes the given data as a blob (and potential metadata as a companion blob).
   * The companion blob will be written first and will be deleted if something goes wrong writing the data.
   */
  public async writeDocument(identifier: ResourceIdentifier, data: Guarded<Readable>, metadata: RepresentationMetadata):
  Promise<void> {
    const key = this.getBlobKey(identifier);
    // The content type needs to be extracted before writing the metadata as it gets removed there
    const { contentType } = metadata;

    const wroteMetadata = await this.writeMetadataBlob(identifier, metadata);

    try {
      await this.containerClient.getBlockBlobClient(key)
        .uploadStream(data, undefined, undefined, { blobHTTPHeaders: { blobContentType: contentType }});
    } catch (error: unknown) {
      // Delete the metadata if there was an error writing the data
      if (wroteMetadata) {
        await this.containerClient.getBlobClient(this.getMetadataKey(identifier)).deleteIfExists();
      }
      throw error;
    }
  }

  /**
   * Creates or overwrites the marker blob of the container and writes metadata to its companion blob if necessary.
   */
  public async writeContainer(identifier: ResourceIdentifier, metadata: RepresentationMetadata): Promise<void> {
    const key = this.getBlobKey(identifier);
    await this.containerClient.getBlockBlobClient(key).upload('', 0);

    await this.writeMetadataBlob(identifier, metadata);
  }

  public async writeMetadata(identifier: ResourceIdentifier, metadata: RepresentationMetadata): Promise<void> {
    await this.writeMetadataBlob(identifier, metadata);
  }

  /**
   * Removes the corresponding blob (or marker blob for containers) and its companion blob.
   */
  public async deleteResource(identifier: ResourceIdentifier): Promise<void> {
    await this.deleteBlob(this.getMetadataKey(identifier));

    if (!await this.deleteBlob(this.getBlobKey(identifier))) {
      throw new NotFoundHttpError();
    }
  }

  /**
   * Writes the metadata of the resource to a companion blob.
   * If no metadata needs to be stored, a (potentially) existing companion blob is deleted instead.
   *
   * @param identifier - Identifier of the resource (not the metadata!).
   * @param metadata - Metadata to write.
   *
   * @returns True if data was written to a companion blob.
   */
  protected async writeMetadataBlob(identifier: ResourceIdentifier, metadata: RepresentationMetadata):
  Promise<boolean> {
    // These are stored by the blob properties or generated when reading
    metadata.remove(RDF.terms.type, LDP.terms.Resource);
    metadata.remove(RDF.terms.type, LDP.terms.Container);
    metadata.remove(RDF.terms.type, LDP.terms.BasicContainer);
    metadata.removeAll(DC.terms.modified);
    metadata.removeAll(CONTENT_TYPE_TERM);
    const quads = metadata.quads();
    const key = this.getMetadataKey(identifier);

    // Write metadata to a companion blob if there are quads remaining
    if (quads.length > 0) {
      const serializedMetadata = serializeQuads(quads, TEXT_TURTLE);
      await this.containerClient.getBlockBlobClient(key)
        .uploadStream(serializedMetadata, undefined, undefined, { blobHTTPHeaders: { blobContentType: TEXT_TURTLE }});
      return true;
    }

    // Delete a (potentially) existing companion blob if no metadata needs to be stored
    await this.containerClient.getBlobClient(key).deleteIfExists();
    return false;
  }

  /**
   * Reads the metadata from the corresponding companion blob.
   * Returns empty metadata if there is no companion blob.
   *
   * @param identifier - Identifier of the resource (not the metadata!).
   */
  private async getRawMetadata(identifier: ResourceIdentifier): Promise<RepresentationMetadata> {
    try {
      const response = await this.downloadBlob(this.getMetadataKey(identifier));
      const readMetadataStream = guardStream(response.readableStreamBody as Readable);
      const quads = await parseQuads(readMetadataStream, { format: TEXT_TURTLE, baseIRI: identifier.path });
      const metadata = new RepresentationMetadata(identifier).addQuads(quads);

      // Already add modified date of the companion blob.
      // Final modified date should be max of data and metadata.
      if (response.lastModified) {
        updateModifiedDate(metadata, response.lastModified);
      }

      return metadata;
    } catch (error: unknown) {
      // Companion blob doesn't exist so return empty metadata
      if (!NotFoundHttpError.isInstance(error)) {
        throw error;
      }
      return new RepresentationMetadata(identifier);
    }
  }

  /**
   * Helper function to add metadata generated from the blob properties.
   *
   * @param metadata - Metadata object to add to.
   * @param properties - Blob properties of the blob corresponding to the resource.
   * @param isContainer - Whether the metadata corresponds to a container.
   */
  private addBlobMetadata(metadata: RepresentationMetadata, properties: AzureBlobProperties, isContainer: boolean):
  void {
    const { contentLength, lastModified } = properties;
    if (lastModified) {
      // Make sure the last modified date is the max of the data and metadata modified date
      const modified = new Date(metadata.get(DC.terms.modified)?.value ?? 0);
      if (modified < lastModified) {
        updateModifiedDate(metadata, lastModified);
      }
      metadata.add(
        POSIX.terms.mtime,
        toLiteral(Math.floor(lastModified.getTime() / 1000), XSD.terms.integer),
        SOLID_META.terms.ResponseMetadata,
      );
    }
    if (!isContainer && typeof contentLength === 'number') {
      metadata.add(POSIX.terms.size, toLiteral(contentLength, XSD.terms.integer), SOLID_META.terms.ResponseMetadata);
    }
  }

  /**
   * Downloads the blob with the given key.
   *
   * @param key - Key of the blob.
   *
   * @throws NotFoundHttpError
   * If the blob does not exist.
   */
  private async downloadBlob(key: string): Promise<BlobDownloadResponseParsed> {
    try {
      return await this.containerClient.getBlobClient(key).download();
    } catch (error: unknown) {
      this.handleAzureError(error);
    }
  }

  /**
   * Gets the properties of the blob with the given key.
   *
   * @param key - Key of the blob.
   *
   * @throws NotFoundHttpError
   * If the blob does not exist.
   */
  private async getBlobProperties(key: string): Promise<AzureBlobProperties> {
    try {
      return await this.containerClient.getBlobClient(key).getProperties();
    } catch (error: unknown) {
      this.handleAzureError(error);
    }
  }

  /**
   * Deletes the blob with the given key if it exists.
   *
   * @param key - Key of the blob.
   *
   * @returns Whether the blob existed.
   */
  private async deleteBlob(key: string): Promise<boolean> {
    try {
      const { succeeded } = await this.containerClient.getBlobClient(key).deleteIfExists();
      return succeeded;
    } catch (error: unknown) {
      this.handleAzureError(error);
    }
  }

  /**
   * Interprets an error thrown by the Azure SDK.
   * {@link RestError}s indicating a missing blob are converted to a {@link NotFoundHttpError},
   * all other errors are thrown again as-is.
   *
   * @param error - Error thrown by the Azure SDK.
   */
  private handleAzureError(error: unknown): never {
    if (error instanceof RestError && (error.statusCode === 404 || error.code === 'BlobNotFound')) {
      throw new NotFoundHttpError('', { cause: error });
    }
    this.logger.error(`Unexpected Azure Blob Storage error: ${createErrorMessage(error)}`);
    throw error;
  }

  /**
   * Determines the blob key corresponding to the given identifier.
   *
   * @param identifier - Identifier to get the key for.
   *
   * @throws NotFoundHttpError
   * If the identifier is not supported by the identifier strategy.
   */
  private getBlobKey(identifier: ResourceIdentifier): string {
    if (!this.identifierStrategy.supportsIdentifier(identifier)) {
      throw new NotFoundHttpError();
    }
    return identifier.path;
  }

  /**
   * Determines the key of the metadata companion blob corresponding to the given identifier.
   *
   * @param identifier - Identifier to get the metadata key for.
   */
  private getMetadataKey(identifier: ResourceIdentifier): string {
    return `${this.getBlobKey(identifier)}${METADATA_SUFFIX}`;
  }

  /**
   * Checks if the given key corresponds to a metadata companion blob.
   *
   * @param key - Key to check.
   */
  private static isMetadataKey(key: string): boolean {
    return key.endsWith(METADATA_SUFFIX);
  }
}
