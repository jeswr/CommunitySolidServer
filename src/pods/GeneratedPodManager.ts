import arrayifyStream from 'arrayify-stream';
import type { Quad } from 'n3';
import type { AuxiliaryIdentifierStrategy } from '../http/auxiliary/AuxiliaryIdentifierStrategy';
import { BasicRepresentation } from '../http/representation/BasicRepresentation';
import type { ResourceIdentifier } from '../http/representation/ResourceIdentifier';
import { getLoggerFor } from '../logging/LogUtil';
import type { ResourceStore } from '../storage/ResourceStore';
import { INTERNAL_QUADS } from '../util/ContentTypes';
import { ConflictHttpError } from '../util/errors/ConflictHttpError';
import { MethodNotAllowedHttpError } from '../util/errors/MethodNotAllowedHttpError';
import { isContainerIdentifier } from '../util/PathUtil';
import { LDP, PIM, RDF } from '../util/Vocabularies';
import { addGeneratedResources } from './generate/GenerateUtil';
import type { ResourcesGenerator } from './generate/ResourcesGenerator';
import type { PodManager } from './PodManager';
import type { PodSettings } from './settings/PodSettings';

/**
 * Pod manager that uses an {@link IdentifierGenerator} and {@link ResourcesGenerator}
 * to create the default resources and identifier for a new pod.
 *
 * Pods are deleted by removing all their resources through the store,
 * so the store behaviour, such as locking and notifications, still applies.
 * A pod at the server base URL can not be deleted.
 */
export class GeneratedPodManager implements PodManager {
  protected readonly logger = getLoggerFor(this);

  private readonly store: ResourceStore;
  private readonly resourcesGenerator: ResourcesGenerator;
  private readonly metadataStrategy: AuxiliaryIdentifierStrategy;
  private readonly baseUrl: string;

  /**
   * @param store - Store to write the pod resources to.
   * @param resourcesGenerator - Generates the initial pod resources.
   * @param metadataStrategy - Strategy to find the metadata resource of the pod root.
   * @param baseUrl - Base URL of the server.
   */
  public constructor(
    store: ResourceStore,
    resourcesGenerator: ResourcesGenerator,
    metadataStrategy: AuxiliaryIdentifierStrategy,
    baseUrl: string,
  ) {
    this.store = store;
    this.resourcesGenerator = resourcesGenerator;
    this.metadataStrategy = metadataStrategy;
    this.baseUrl = baseUrl;
  }

  /**
   * Creates a new pod, pre-populating it with the resources created by the data generator.
   * Will throw an error if the given identifier already has a resource.
   */
  public async createPod(settings: PodSettings, overwrite: boolean): Promise<void> {
    this.logger.info(`Creating pod ${settings.base.path}`);
    if (!overwrite && await this.store.hasResource(settings.base)) {
      throw new ConflictHttpError(`There already is a resource at ${settings.base.path}`);
    }

    const count = await addGeneratedResources(settings, this.resourcesGenerator, this.store);
    this.logger.info(`Added ${count} resources to ${settings.base.path}`);
  }

  public async deletePod(base: ResourceIdentifier): Promise<void> {
    if (base.path === this.baseUrl) {
      throw new MethodNotAllowedHttpError([ 'DELETE' ], 'The pod at the root of the server can not be deleted.');
    }
    if (!await this.store.hasResource(base)) {
      this.logger.warn(`Pod ${base.path} to be deleted does not exist`);
      return;
    }

    this.logger.info(`Deleting pod ${base.path}`);
    // Find everything first so nothing gets deleted if the pod contains another storage
    const resources = await this.findDescendants(base, true);
    for (const identifier of resources) {
      await this.store.deleteResource(identifier);
    }

    // The store does not allow deleting a storage root container,
    // so the `pim:Storage` type is removed first by emptying its metadata.
    await this.store.setRepresentation(
      this.metadataStrategy.getAuxiliaryIdentifier(base),
      new BasicRepresentation([], INTERNAL_QUADS),
    );
    await this.store.deleteResource(base);
    this.logger.info(`Deleted ${resources.length + 1} resources from ${base.path}`);
  }

  /**
   * Returns all resources in the given container, with every resource listed before its parent container.
   * Throws an error if one of the containers, other than the root, is a storage.
   */
  protected async findDescendants(container: ResourceIdentifier, isRoot: boolean): Promise<ResourceIdentifier[]> {
    const representation = await this.store.getRepresentation(container, { type: { [INTERNAL_QUADS]: 1 }});
    if (!isRoot && representation.metadata.has(RDF.terms.type, PIM.terms.Storage)) {
      representation.data.destroy();
      throw new ConflictHttpError(`${container.path} is a separate storage and can not be deleted with its parent.`);
    }

    const quads: Quad[] = await arrayifyStream(representation.data);
    const result: ResourceIdentifier[] = [];
    for (const { subject, predicate, object } of quads) {
      if (subject.value === container.path && predicate.equals(LDP.terms.contains)) {
        const child = { path: object.value };
        if (isContainerIdentifier(child)) {
          result.push(...await this.findDescendants(child, false));
        }
        result.push(child);
      }
    }
    return result;
  }
}
