import { DeletePodHandler } from '../../../../../src/identity/interaction/pod/DeletePodHandler';
import type { PodIdRoute } from '../../../../../src/identity/interaction/pod/PodIdRoute';
import type { PodStore } from '../../../../../src/identity/interaction/pod/util/PodStore';
import type { WebIdStore } from '../../../../../src/identity/interaction/webid/util/WebIdStore';
import { NotFoundHttpError } from '../../../../../src/util/errors/NotFoundHttpError';

describe('A DeletePodHandler', (): void => {
  const id = 'id';
  const accountId = 'accountId';
  const target = { path: 'http://example.com/.account/pod/id/' };
  const baseUrl = 'http://example.com/pod/';
  let podStore: jest.Mocked<PodStore>;
  let route: jest.Mocked<PodIdRoute>;
  let webIdStore: jest.Mocked<WebIdStore>;
  let handler: DeletePodHandler;

  beforeEach(async(): Promise<void> => {
    podStore = {
      get: jest.fn().mockResolvedValue({ baseUrl, accountId }),
      delete: jest.fn(),
    } satisfies Partial<PodStore> as any;

    route = {
      getPath: jest.fn(),
      matchPath: jest.fn().mockReturnValue({ accountId, podId: id }),
    };

    webIdStore = {
      findLinks: jest.fn().mockResolvedValue([
        { id: 'inPod', webId: `${baseUrl}profile/card#me` },
        { id: 'external', webId: 'http://example.org/card#me' },
      ]),
      delete: jest.fn(),
    } satisfies Partial<WebIdStore> as any;

    handler = new DeletePodHandler(podStore, route, webIdStore);
  });

  it('deletes the pod and unlinks the WebIDs it contained.', async(): Promise<void> => {
    await expect(handler.handle({ target, accountId } as any)).resolves.toEqual({ json: {}});
    expect(podStore.delete).toHaveBeenCalledTimes(1);
    expect(podStore.delete).toHaveBeenLastCalledWith(id);
    expect(webIdStore.findLinks).toHaveBeenLastCalledWith(accountId);
    expect(webIdStore.delete).toHaveBeenCalledTimes(1);
    expect(webIdStore.delete).toHaveBeenLastCalledWith('inPod');
  });

  it('throws a 404 if the authenticated account is not the creator.', async(): Promise<void> => {
    await expect(handler.handle({ target, accountId: 'otherId' } as any)).rejects.toThrow(NotFoundHttpError);
    expect(podStore.delete).toHaveBeenCalledTimes(0);
    expect(webIdStore.delete).toHaveBeenCalledTimes(0);
  });

  it('does not unlink WebIDs if deleting the pod fails.', async(): Promise<void> => {
    podStore.delete.mockRejectedValueOnce(new Error('bad data'));
    await expect(handler.handle({ target, accountId } as any)).rejects.toThrow('bad data');
    expect(webIdStore.delete).toHaveBeenCalledTimes(0);
  });
});
