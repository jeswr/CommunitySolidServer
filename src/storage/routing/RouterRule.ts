import type { Representation } from '../../http/representation/Representation';
import type { ResourceIdentifier } from '../../http/representation/ResourceIdentifier';
import { AsyncHandler } from '../../util/handlers/AsyncHandler';
import type { ResourceStorageHints } from '../ResourceSet';
import type { ResourceStore } from '../ResourceStore';

export interface RouterRuleInput {
  identifier: ResourceIdentifier;
  representation?: Representation;
  hints?: ResourceStorageHints;
}

/**
 * Finds which store needs to be accessed for the given resource,
 * potentially based on the Representation of incoming data.
 */
export abstract class RouterRule
  extends AsyncHandler<RouterRuleInput, ResourceStore> {}
