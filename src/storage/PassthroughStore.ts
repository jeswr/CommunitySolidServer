import type { Patch } from '../http/representation/Patch';
import type { Representation } from '../http/representation/Representation';
import type { RepresentationPreferences } from '../http/representation/RepresentationPreferences';
import type { ResourceIdentifier } from '../http/representation/ResourceIdentifier';
import type { Conditions } from './conditions/Conditions';
import type { ResourceStorageHints } from './ResourceSet';
import type { ChangeMap, ResourceStore } from './ResourceStore';

/**
 * Store that calls the corresponding functions of the source Store.
 * Can be extended by stores that do not want to override all functions
 * by implementing a decorator pattern.
 */
export class PassthroughStore<T extends ResourceStore = ResourceStore> implements ResourceStore {
  protected readonly source: T;

  public constructor(source: T) {
    this.source = source;
  }

  public async hasResource(identifier: ResourceIdentifier, hints?: ResourceStorageHints): Promise<boolean> {
    return this.source.hasResource(identifier, hints);
  }

  public async getRepresentation(
    identifier: ResourceIdentifier,
    preferences: RepresentationPreferences,
    conditions?: Conditions,
    hints?: ResourceStorageHints,
  ): Promise<Representation> {
    return this.source.getRepresentation(identifier, preferences, conditions, hints);
  }

  public async addResource(
    container: ResourceIdentifier,
    representation: Representation,
    conditions?: Conditions,
  ): Promise<ChangeMap> {
    return this.source.addResource(container, representation, conditions);
  }

  public async deleteResource(
    identifier: ResourceIdentifier,
    conditions?: Conditions,
    hints?: ResourceStorageHints,
  ): Promise<ChangeMap> {
    return this.source.deleteResource(identifier, conditions, hints);
  }

  public async modifyResource(
    identifier: ResourceIdentifier,
    patch: Patch,
    conditions?: Conditions,
  ): Promise<ChangeMap> {
    return this.source.modifyResource(identifier, patch, conditions);
  }

  public async setRepresentation(
    identifier: ResourceIdentifier,
    representation: Representation,
    conditions?: Conditions,
    hints?: ResourceStorageHints,
  ): Promise<ChangeMap> {
    return this.source.setRepresentation(identifier, representation, conditions, hints);
  }
}
