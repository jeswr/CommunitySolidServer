import type { ResourceStore } from '../../../src/storage/ResourceStore';
import { RoutingResourceStore } from '../../../src/storage/RoutingResourceStore';
import { NotFoundHttpError } from '../../../src/util/errors/NotFoundHttpError';
import { NotImplementedHttpError } from '../../../src/util/errors/NotImplementedHttpError';
import { StaticAsyncHandler } from '../../util/StaticAsyncHandler';

describe('A RoutingResourceStore', (): void => {
  let store: RoutingResourceStore;
  let source: ResourceStore;
  let rule: StaticAsyncHandler<ResourceStore>;
  const identifier = { path: 'identifier' };

  beforeEach(async(): Promise<void> => {
    source = {
      getRepresentation: jest.fn(),
      addResource: jest.fn(),
      setRepresentation: jest.fn(),
      modifyResource: jest.fn(),
      deleteResource: jest.fn(),
      hasResource: jest.fn(),
    };

    rule = new StaticAsyncHandler(true, source);

    store = new RoutingResourceStore(rule);
  });

  it('calls getRepresentation on the resulting store.', async(): Promise<void> => {
    await expect(store.getRepresentation(identifier, 'preferences' as any, 'conditions' as any))
      .resolves.toBeUndefined();
    expect(source.getRepresentation).toHaveBeenCalledTimes(1);
    expect(source.getRepresentation).toHaveBeenLastCalledWith(identifier, 'preferences', 'conditions', undefined);
  });

  it('calls addRepresentation on the resulting store.', async(): Promise<void> => {
    await expect(store.addResource(identifier, 'representation' as any, 'conditions' as any))
      .resolves.toBeUndefined();
    expect(source.addResource).toHaveBeenCalledTimes(1);
    expect(source.addResource).toHaveBeenLastCalledWith(identifier, 'representation', 'conditions');
  });

  it('calls setRepresentation on the resulting store.', async(): Promise<void> => {
    await expect(store.setRepresentation(identifier, 'representation' as any, 'conditions' as any))
      .resolves.toBeUndefined();
    expect(source.setRepresentation).toHaveBeenCalledTimes(1);
    expect(source.setRepresentation).toHaveBeenLastCalledWith(identifier, 'representation', 'conditions', undefined);
  });

  it('calls modifyResource on the resulting store.', async(): Promise<void> => {
    await expect(store.modifyResource(identifier, 'patch' as any, 'conditions' as any))
      .resolves.toBeUndefined();
    expect(source.modifyResource).toHaveBeenCalledTimes(1);
    expect(source.modifyResource).toHaveBeenLastCalledWith(identifier, 'patch', 'conditions');
  });

  it('calls deleteResource on the resulting store.', async(): Promise<void> => {
    await expect(store.deleteResource(identifier, 'conditions' as any))
      .resolves.toBeUndefined();
    expect(source.deleteResource).toHaveBeenCalledTimes(1);
    expect(source.deleteResource).toHaveBeenLastCalledWith(identifier, 'conditions', undefined);
  });

  it('calls hasResource on the resulting store.', async(): Promise<void> => {
    await expect(store.hasResource(identifier)).resolves.toBeUndefined();
    expect(source.hasResource).toHaveBeenCalledTimes(1);
    expect(source.hasResource).toHaveBeenLastCalledWith(identifier, undefined);
  });

  it('forwards storage hints to the selected store.', async(): Promise<void> => {
    const hints = { contentType: { candidates: [ 'application/json' ], exhaustive: false }};
    const ruleSpy = jest.spyOn(rule, 'handleSafe');

    await store.hasResource(identifier, hints);
    await store.getRepresentation(identifier, 'preferences' as any, 'conditions' as any, hints);
    await store.setRepresentation(identifier, 'representation' as any, 'conditions' as any, hints);
    await store.deleteResource(identifier, 'conditions' as any, hints);

    expect(source.hasResource).toHaveBeenCalledWith(identifier, hints);
    expect(source.getRepresentation).toHaveBeenCalledWith(identifier, 'preferences', 'conditions', hints);
    expect(source.setRepresentation).toHaveBeenCalledWith(identifier, 'representation', 'conditions', hints);
    expect(source.deleteResource).toHaveBeenCalledWith(identifier, 'conditions', hints);
    expect(ruleSpy).toHaveBeenNthCalledWith(1, { identifier, hints });
    expect(ruleSpy).toHaveBeenNthCalledWith(2, { identifier, hints });
    expect(ruleSpy).toHaveBeenNthCalledWith(3, { identifier, representation: 'representation', hints });
    expect(ruleSpy).toHaveBeenNthCalledWith(4, { identifier, hints });
  });

  it('throws a 404 if there is no body and no store was found.', async(): Promise<void> => {
    rule.canHandle = (): any => {
      throw new NotImplementedHttpError();
    };
    await expect(store.getRepresentation(identifier, 'preferences' as any, 'conditions' as any))
      .rejects.toThrow(NotFoundHttpError);
  });

  it('re-throws the error if something went wrong.', async(): Promise<void> => {
    rule.canHandle = (): any => {
      throw new Error('error');
    };
    await expect(store.getRepresentation(identifier, 'preferences' as any, 'conditions' as any))
      .rejects.toThrow('error');
  });
});
