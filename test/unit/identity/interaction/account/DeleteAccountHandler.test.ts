import { RepresentationMetadata } from '../../../../../src/http/representation/RepresentationMetadata';
import { DeleteAccountHandler } from '../../../../../src/identity/interaction/account/DeleteAccountHandler';
import type { AccountStore } from '../../../../../src/identity/interaction/account/util/AccountStore';
import type { CookieStore } from '../../../../../src/identity/interaction/account/util/CookieStore';
import type { PodStore } from '../../../../../src/identity/interaction/pod/util/PodStore';
import { NotFoundHttpError } from '../../../../../src/util/errors/NotFoundHttpError';
import { NotImplementedHttpError } from '../../../../../src/util/errors/NotImplementedHttpError';
import { SOLID_HTTP } from '../../../../../src/util/Vocabularies';

describe('A DeleteAccountHandler', (): void => {
  const accountId = 'accountId';
  const cookie = 'cookie';
  const target = { path: 'http://example.com/.account/account/accountId/' };
  let metadata: RepresentationMetadata;
  let deleteAccount: jest.Mock;
  let deletePod: jest.Mock;
  let accountStore: jest.Mocked<AccountStore>;
  let podStore: jest.Mocked<PodStore>;
  let cookieStore: jest.Mocked<CookieStore>;
  let handler: DeleteAccountHandler;

  beforeEach(async(): Promise<void> => {
    metadata = new RepresentationMetadata({ [SOLID_HTTP.accountCookie]: cookie });

    accountStore = {
      delete: deleteAccount = jest.fn(),
    } satisfies Partial<AccountStore> as any;

    podStore = {
      findPods: jest.fn().mockResolvedValue([
        { id: 'pod1', baseUrl: 'http://example.com/pod1/' },
        { id: 'pod2', baseUrl: 'http://example.com/pod2/' },
      ]),
      delete: deletePod = jest.fn(),
    } satisfies Partial<PodStore> as any;

    cookieStore = {
      get: jest.fn().mockResolvedValue(accountId),
      delete: jest.fn(),
    } satisfies Partial<CookieStore> as any;

    handler = new DeleteAccountHandler(accountStore, podStore, cookieStore);
  });

  it('deletes all pods and the account, and logs out.', async(): Promise<void> => {
    const { json, metadata: outputMetadata } = await handler.handle({ target, metadata, accountId } as any);
    expect(json).toEqual({});

    expect(podStore.findPods).toHaveBeenLastCalledWith(accountId);
    expect(podStore.delete).toHaveBeenCalledTimes(2);
    expect(podStore.delete).toHaveBeenNthCalledWith(1, 'pod1');
    expect(podStore.delete).toHaveBeenNthCalledWith(2, 'pod2');
    expect(accountStore.delete).toHaveBeenCalledTimes(1);
    expect(accountStore.delete).toHaveBeenLastCalledWith(accountId);
    expect(deletePod.mock.invocationCallOrder[1]).toBeLessThan(deleteAccount.mock.invocationCallOrder[0]);

    expect(cookieStore.delete).toHaveBeenLastCalledWith(cookie);
    expect(outputMetadata?.get(SOLID_HTTP.terms.accountCookieExpiration)?.value).toBe(new Date(0).toISOString());
  });

  it('keeps the account if deleting a pod fails.', async(): Promise<void> => {
    deletePod.mockRejectedValueOnce(new Error('bad data'));
    await expect(handler.handle({ target, metadata, accountId } as any)).rejects.toThrow('bad data');
    expect(accountStore.delete).toHaveBeenCalledTimes(0);
    expect(cookieStore.delete).toHaveBeenCalledTimes(0);
  });

  it('errors if the account store does not support deletion.', async(): Promise<void> => {
    delete accountStore.delete;
    await expect(handler.handle({ target, metadata, accountId } as any)).rejects.toThrow(NotImplementedHttpError);
    expect(deletePod).toHaveBeenCalledTimes(0);
    expect(cookieStore.delete).toHaveBeenCalledTimes(0);
  });

  it('errors if the pod store does not support deletion.', async(): Promise<void> => {
    delete podStore.delete;
    await expect(handler.handle({ target, metadata, accountId } as any)).rejects.toThrow(NotImplementedHttpError);
    expect(deleteAccount).toHaveBeenCalledTimes(0);
    expect(cookieStore.delete).toHaveBeenCalledTimes(0);
  });

  it('throws a 404 if there is no account.', async(): Promise<void> => {
    await expect(handler.handle({ target, metadata } as any)).rejects.toThrow(NotFoundHttpError);
    expect(accountStore.delete).toHaveBeenCalledTimes(0);
  });
});
