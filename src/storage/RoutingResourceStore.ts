import type { Patch } from '../http/representation/Patch';
import type { Representation } from '../http/representation/Representation';
import type { RepresentationPreferences } from '../http/representation/RepresentationPreferences';
import type { ResourceIdentifier } from '../http/representation/ResourceIdentifier';
import { NotFoundHttpError } from '../util/errors/NotFoundHttpError';
import { NotImplementedHttpError } from '../util/errors/NotImplementedHttpError';
import type { Conditions } from './conditions/Conditions';
import type { ResourceStorageHints } from './ResourceSet';
import type { ChangeMap, ResourceStore } from './ResourceStore';
import type { RouterRule } from './routing/RouterRule';

/**
 * Store that routes the incoming request to a specific store based on the stored ResourceRouter.
 * In case no store was found for one of the functions that take no data (GET/PATCH/DELETE),
 * a 404 will be thrown. In the other cases the error of the router will be thrown (which would probably be 400).
 */
export class RoutingResourceStore implements ResourceStore {
  private readonly rule: RouterRule;

  public constructor(rule: RouterRule) {
    this.rule = rule;
  }

  public async hasResource(identifier: ResourceIdentifier, hints?: ResourceStorageHints):
  Promise<boolean> {
    return (await this.getStore(identifier, undefined, hints)).hasResource(identifier, hints);
  }

  public async getRepresentation(
    identifier: ResourceIdentifier,
    preferences: RepresentationPreferences,
    conditions?: Conditions,
    hints?: ResourceStorageHints,
  ): Promise<Representation> {
    return (await this.getStore(identifier, undefined, hints))
      .getRepresentation(identifier, preferences, conditions, hints);
  }

  public async addResource(
    container: ResourceIdentifier,
    representation: Representation,
    conditions?: Conditions,
  ): Promise<ChangeMap> {
    return (await this.getStore(container, representation)).addResource(container, representation, conditions);
  }

  public async setRepresentation(
    identifier: ResourceIdentifier,
    representation: Representation,
    conditions?: Conditions,
    hints?: ResourceStorageHints,
  ): Promise<ChangeMap> {
    return (await this.getStore(identifier, representation, hints))
      .setRepresentation(identifier, representation, conditions, hints);
  }

  public async deleteResource(
    identifier: ResourceIdentifier,
    conditions?: Conditions,
    hints?: ResourceStorageHints,
  ): Promise<ChangeMap> {
    return (await this.getStore(identifier, undefined, hints)).deleteResource(identifier, conditions, hints);
  }

  public async modifyResource(
    identifier: ResourceIdentifier,
    patch: Patch,
    conditions?: Conditions,
  ): Promise<ChangeMap> {
    return (await this.getStore(identifier)).modifyResource(identifier, patch, conditions);
  }

  private async getStore(
    identifier: ResourceIdentifier,
    representation?: Representation,
    hints?: ResourceStorageHints,
  ): Promise<ResourceStore> {
    if (representation) {
      return this.rule.handleSafe(hints ? { identifier, representation, hints } : { identifier, representation });
    }

    // In case there is no incoming data we want to return 404 if no store was found
    try {
      return await this.rule.handleSafe(hints ? { identifier, hints } : { identifier });
    } catch (error: unknown) {
      if (NotImplementedHttpError.isInstance(error)) {
        throw new NotFoundHttpError('', { cause: error });
      }
      throw error;
    }
  }
}
