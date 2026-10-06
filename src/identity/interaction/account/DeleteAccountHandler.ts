import type { EmptyObject } from '../../../util/map/MapUtil';
import type { JsonRepresentation } from '../InteractionUtil';
import type { JsonInteractionHandlerInput } from '../JsonInteractionHandler';
import { LogoutHandler } from '../login/LogoutHandler';
import type { PodStore } from '../pod/util/PodStore';
import { assertAccountId } from './util/AccountUtil';
import type { AccountStore } from './util/AccountStore';
import type { CookieStore } from './util/CookieStore';

/**
 * Deletes the account, together with all the pods it created, and logs the user out.
 * The pods are deleted first, so the account remains if deleting one of them fails.
 */
export class DeleteAccountHandler extends LogoutHandler {
  private readonly accountStore: AccountStore;
  private readonly podStore: PodStore;

  public constructor(accountStore: AccountStore, podStore: PodStore, cookieStore: CookieStore) {
    super(cookieStore);
    this.accountStore = accountStore;
    this.podStore = podStore;
  }

  public async handle(input: JsonInteractionHandlerInput): Promise<JsonRepresentation<EmptyObject>> {
    const { accountId } = input;
    assertAccountId(accountId);

    for (const { id } of await this.podStore.findPods(accountId)) {
      await this.podStore.delete(id);
    }
    await this.accountStore.delete(accountId);

    return super.handle(input);
  }
}
