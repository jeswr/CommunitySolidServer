import { NotImplementedHttpError } from '../../../util/errors/NotImplementedHttpError';
import type { EmptyObject } from '../../../util/map/MapUtil';
import { parsePath, verifyAccountId } from '../account/util/AccountUtil';
import type { JsonRepresentation } from '../InteractionUtil';
import type { JsonInteractionHandlerInput } from '../JsonInteractionHandler';
import { JsonInteractionHandler } from '../JsonInteractionHandler';
import type { WebIdStore } from '../webid/util/WebIdStore';
import type { PodIdRoute } from './PodIdRoute';
import type { PodStore } from './util/PodStore';

/**
 * Deletes a pod, and all the data it contains, created by the account.
 * WebIDs of the account that are part of the pod are unlinked from the account,
 * as they no longer exist after the pod is deleted.
 */
export class DeletePodHandler extends JsonInteractionHandler<EmptyObject> {
  private readonly podStore: PodStore;
  private readonly podRoute: PodIdRoute;
  private readonly webIdStore: WebIdStore;

  public constructor(podStore: PodStore, podRoute: PodIdRoute, webIdStore: WebIdStore) {
    super();
    this.podStore = podStore;
    this.podRoute = podRoute;
    this.webIdStore = webIdStore;
  }

  public async handle({ target, accountId }: JsonInteractionHandlerInput): Promise<JsonRepresentation<EmptyObject>> {
    const { podId } = parsePath(this.podRoute, target.path);
    const pod = await this.podStore.get(podId);
    verifyAccountId(accountId, pod?.accountId);
    if (!this.podStore.delete) {
      throw new NotImplementedHttpError('Deleting pods is not supported by this server.');
    }

    await this.podStore.delete(podId);

    for (const { id, webId } of await this.webIdStore.findLinks(pod.accountId)) {
      if (webId.startsWith(pod.baseUrl)) {
        await this.webIdStore.delete(id);
      }
    }

    return { json: {}};
  }
}
