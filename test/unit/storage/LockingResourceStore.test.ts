import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import type { AuxiliaryIdentifierStrategy } from '../../../src/http/auxiliary/AuxiliaryIdentifierStrategy';
import type { Patch } from '../../../src/http/representation/Patch';
import type { Representation } from '../../../src/http/representation/Representation';
import type { ResourceIdentifier } from '../../../src/http/representation/ResourceIdentifier';
import { LockingResourceStore } from '../../../src/storage/LockingResourceStore';
import type { ResourceStore } from '../../../src/storage/ResourceStore';
import type { ExpiringReadWriteLocker } from '../../../src/util/locking/ExpiringReadWriteLocker';
import type { ReadWriteLocker } from '../../../src/util/locking/ReadWriteLocker';
import type { PromiseOrValue } from '../../../src/util/PromiseUtil';
import { guardedStreamFrom } from '../../../src/util/StreamUtil';
import { flushPromises } from '../../util/Util';

function emptyFn(): void {
  // Empty
}

describe('A LockingResourceStore', (): void => {
  const auxiliaryId = { path: 'http://test.com/foo.dummy' };
  const subjectId = { path: 'http://test.com/foo' };
  let data: Representation;
  let store: LockingResourceStore;
  let locker: jest.Mocked<ExpiringReadWriteLocker>;
  let source: ResourceStore;
  let auxiliaryStrategy: AuxiliaryIdentifierStrategy;
  let order: string[];
  let timeoutTrigger: EventEmitter;
  let readable: Readable;
  let maintainLock: jest.Mock;

  beforeEach(async(): Promise<void> => {
    order = [];
    function addOrder<T>(name: string, input?: T): T | undefined {
      order.push(name);
      return input;
    }

    data = { data: guardedStreamFrom([ 1, 2, 3 ]) } as any;

    readable = guardedStreamFrom([ 1, 2, 3 ]);
    const destroy = readable.destroy.bind(readable);
    jest.spyOn(readable, 'destroy').mockImplementation((error): any => destroy.call(readable, error));
    source = {
      getRepresentation: jest.fn((): any => addOrder('getRepresentation', { data: readable } as Representation)),
      addResource: jest.fn((): any => addOrder('addResource')),
      setRepresentation: jest.fn((): any => addOrder('setRepresentation')),
      deleteResource: jest.fn((): any => addOrder('deleteResource')),
      modifyResource: jest.fn((): any => addOrder('modifyResource')),
      hasResource: jest.fn((): any => addOrder('hasResource')),
    };

    timeoutTrigger = new EventEmitter();
    maintainLock = jest.fn();

    locker = {
      withReadLock: jest.fn(async <T>(
        id: ResourceIdentifier,
        whileLocked: (maintainLock: () => void) => PromiseOrValue<T>,
      ): Promise<T> => {
        order.push('lock read');
        try {
          // Allows simulating a timeout event
          const timeout = new Promise<never>((resolve, reject): any => timeoutTrigger.on('timeout', (): void => {
            order.push('timeout');
            reject(new Error('timeout'));
          }));
          return await Promise.race([ Promise.resolve(whileLocked(maintainLock)), timeout ]);
        } finally {
          order.push('unlock read');
        }
      }) satisfies ReadWriteLocker['withReadLock'] as any,
      withWriteLock: jest.fn(async <T>(
        identifier: ResourceIdentifier,
        whileLocked: (maintainLock: () => void) => PromiseOrValue<T>,
      ): Promise<T> => {
        order.push('lock write');
        try {
          // Allows simulating a timeout event
          const timeout = new Promise<never>((resolve, reject): any => timeoutTrigger.on('timeout', (): void => {
            order.push('timeout');
            reject(new Error('timeout'));
          }));
          return await Promise.race([ Promise.resolve(whileLocked(emptyFn)), timeout ]);
        } finally {
          order.push('unlock write');
        }
      }) satisfies ReadWriteLocker['withWriteLock'] as any,
    };

    auxiliaryStrategy = {
      isAuxiliaryIdentifier: jest.fn((id: ResourceIdentifier): any => id.path.endsWith('.dummy')),
      getSubjectIdentifier: jest.fn((id: ResourceIdentifier): any => ({ path: id.path.slice(0, -6) })),
    } as any;

    store = new LockingResourceStore(source, locker, auxiliaryStrategy);
  });

  function registerEventOrder(eventSource: EventEmitter, event: string): void {
    eventSource.on(event, (): void => {
      order.push(event);
    });
  }

  it('acquires a lock on the container when adding a representation.', async(): Promise<void> => {
    await store.addResource(subjectId, data);
    expect(locker.withWriteLock).toHaveBeenCalledTimes(1);
    expect(locker.withWriteLock.mock.calls[0][0]).toEqual(subjectId);
    expect(source.addResource).toHaveBeenCalledTimes(1);
    expect(source.addResource).toHaveBeenLastCalledWith(subjectId, data, undefined);
    expect(order).toEqual([ 'lock write', 'addResource', 'unlock write' ]);

    order = [];
    await expect(store.addResource(auxiliaryId, data)).resolves.toBeUndefined();
    expect(locker.withWriteLock).toHaveBeenCalledTimes(2);
    expect(locker.withWriteLock.mock.calls[1][0]).toEqual(subjectId);
    expect(source.addResource).toHaveBeenCalledTimes(2);
    expect(source.addResource).toHaveBeenLastCalledWith(auxiliaryId, data, undefined);
    expect(order).toEqual([ 'lock write', 'addResource', 'unlock write' ]);
  });

  it('acquires a lock on the resource when setting its representation.', async(): Promise<void> => {
    await store.setRepresentation(subjectId, data);
    expect(locker.withWriteLock).toHaveBeenCalledTimes(1);
    expect(locker.withWriteLock.mock.calls[0][0]).toEqual(subjectId);
    expect(source.setRepresentation).toHaveBeenCalledTimes(1);
    expect(source.setRepresentation).toHaveBeenLastCalledWith(subjectId, data, undefined);
    expect(order).toEqual([ 'lock write', 'setRepresentation', 'unlock write' ]);

    order = [];
    await expect(store.setRepresentation(auxiliaryId, data)).resolves.toBeUndefined();
    expect(locker.withWriteLock).toHaveBeenCalledTimes(2);
    expect(locker.withWriteLock.mock.calls[1][0]).toEqual(subjectId);
    expect(source.setRepresentation).toHaveBeenCalledTimes(2);
    expect(source.setRepresentation).toHaveBeenLastCalledWith(auxiliaryId, data, undefined);
    expect(order).toEqual([ 'lock write', 'setRepresentation', 'unlock write' ]);
  });

  it('acquires a lock on the resource when deleting it.', async(): Promise<void> => {
    await store.deleteResource(subjectId);
    expect(locker.withWriteLock).toHaveBeenCalledTimes(1);
    expect(locker.withWriteLock.mock.calls[0][0]).toEqual(subjectId);
    expect(source.deleteResource).toHaveBeenCalledTimes(1);
    expect(source.deleteResource).toHaveBeenLastCalledWith(subjectId, undefined);
    expect(order).toEqual([ 'lock write', 'deleteResource', 'unlock write' ]);

    order = [];
    await expect(store.deleteResource(auxiliaryId)).resolves.toBeUndefined();
    expect(locker.withWriteLock).toHaveBeenCalledTimes(2);
    expect(locker.withWriteLock.mock.calls[1][0]).toEqual(subjectId);
    expect(source.deleteResource).toHaveBeenCalledTimes(2);
    expect(source.deleteResource).toHaveBeenLastCalledWith(auxiliaryId, undefined);
    expect(order).toEqual([ 'lock write', 'deleteResource', 'unlock write' ]);
  });

  it('acquires a lock on the resource when modifying its representation.', async(): Promise<void> => {
    await store.modifyResource(subjectId, data as Patch);
    expect(locker.withWriteLock).toHaveBeenCalledTimes(1);
    expect(locker.withWriteLock.mock.calls[0][0]).toEqual(subjectId);
    expect(source.modifyResource).toHaveBeenCalledTimes(1);
    expect(source.modifyResource).toHaveBeenLastCalledWith(subjectId, data, undefined);
    expect(order).toEqual([ 'lock write', 'modifyResource', 'unlock write' ]);

    order = [];
    await expect(store.modifyResource(auxiliaryId, data as Patch)).resolves.toBeUndefined();
    expect(locker.withWriteLock).toHaveBeenCalledTimes(2);
    expect(locker.withWriteLock.mock.calls[1][0]).toEqual(subjectId);
    expect(source.modifyResource).toHaveBeenCalledTimes(2);
    expect(source.modifyResource).toHaveBeenLastCalledWith(auxiliaryId, data, undefined);
    expect(order).toEqual([ 'lock write', 'modifyResource', 'unlock write' ]);
  });

  it('resets the write lock expiration every time incoming data is read.', async(): Promise<void> => {
    const originalRead = jest.spyOn(data.data, 'read');
    const maintainLock = jest.fn();
    locker.withWriteLock.mockImplementationOnce((async <T>(
      identifier: ResourceIdentifier,
      whileLocked: (maintain: () => void) => PromiseOrValue<T>,
    ): Promise<T> => whileLocked(maintainLock)) satisfies ReadWriteLocker['withWriteLock'] as any);
    jest.spyOn(source, 'setRepresentation').mockImplementation(
      async(identifier: ResourceIdentifier, representation: Representation): Promise<any> => {
        representation.data.read();
        representation.data.read();
        order.push('setRepresentation');
      },
    );

    await store.setRepresentation(subjectId, data);
    expect(locker.withWriteLock).toHaveBeenCalledTimes(1);
    expect(source.setRepresentation).toHaveBeenCalledTimes(1);
    expect(source.setRepresentation).toHaveBeenLastCalledWith(subjectId, data, undefined);
    expect(maintainLock).toHaveBeenCalledTimes(2);

    // The original read function is restored once the write is finished
    expect(data.data.read).toBe(originalRead);
    data.data.read();
    expect(maintainLock).toHaveBeenCalledTimes(2);
  });

  it('destroys the incoming data stream if the write lock expires.', async(): Promise<void> => {
    const originalRead = jest.spyOn(data.data, 'read');
    const destroy = jest.spyOn(data.data, 'destroy');
    jest.spyOn(source, 'setRepresentation').mockImplementation((): any => {
      order.push('useless set');
      // This will never resolve
      return new Promise(emptyFn);
    });

    const prom = store.setRepresentation(subjectId, data);

    timeoutTrigger.emit('timeout');

    await expect(prom).rejects.toThrow('timeout');
    expect(locker.withWriteLock).toHaveBeenCalledTimes(1);
    expect(source.setRepresentation).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenLastCalledWith(new Error('timeout'));
    expect(data.data.read).toBe(originalRead);
    expect(order).toEqual([ 'lock write', 'useless set', 'timeout', 'unlock write' ]);
  });

  it('does not destroy the incoming data stream if the write itself errors.', async(): Promise<void> => {
    const destroy = jest.spyOn(data.data, 'destroy');
    jest.spyOn(source, 'setRepresentation').mockImplementation((): any => {
      order.push('bad set');
      throw new Error('dummy');
    });

    await expect(store.setRepresentation(subjectId, data)).rejects.toThrow('dummy');
    expect(locker.withWriteLock).toHaveBeenCalledTimes(1);
    expect(source.setRepresentation).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(0);
    expect(order).toEqual([ 'lock write', 'bad set', 'unlock write' ]);
  });

  it('does not destroy the incoming data stream if the write lock can not be acquired.', async(): Promise<void> => {
    const destroy = jest.spyOn(data.data, 'destroy');
    locker.withWriteLock.mockImplementationOnce(async(): Promise<never> => {
      order.push('failed lock');
      throw new Error('lock error');
    });

    await expect(store.setRepresentation(subjectId, data)).rejects.toThrow('lock error');
    expect(locker.withWriteLock).toHaveBeenCalledTimes(1);
    expect(source.setRepresentation).toHaveBeenCalledTimes(0);
    expect(destroy).toHaveBeenCalledTimes(0);
    expect(order).toEqual([ 'failed lock' ]);
  });

  it('releases the lock if an error was thrown.', async(): Promise<void> => {
    source.getRepresentation = async(): Promise<any> => {
      order.push('bad get');
      throw new Error('dummy');
    };
    await expect(store.getRepresentation(subjectId, {})).rejects.toThrow('dummy');
    expect(locker.withReadLock).toHaveBeenCalledTimes(1);
    expect(locker.withReadLock.mock.calls[0][0]).toEqual(subjectId);
    expect(order).toEqual([ 'lock read', 'bad get', 'unlock read' ]);
  });

  it('releases the lock on the resource when data has been read.', async(): Promise<void> => {
    // Read all data from the representation
    const representation = await store.getRepresentation(subjectId, {});
    representation.data.on('data', (): any => true);
    registerEventOrder(representation.data, 'end');

    // Provide opportunity for async events
    await flushPromises();

    // Verify the lock was acquired and released at the right time
    expect(locker.withReadLock).toHaveBeenCalledTimes(1);
    expect(locker.withReadLock.mock.calls[0][0]).toEqual(subjectId);
    expect(source.getRepresentation).toHaveBeenCalledTimes(1);
    expect(source.getRepresentation).toHaveBeenLastCalledWith(subjectId, {}, undefined);
    expect(order).toEqual([ 'lock read', 'getRepresentation', 'end', 'unlock read' ]);
  });

  it('preserves the source stream identity while maintaining the lock.', async(): Promise<void> => {
    // Capture the exact method reference to verify it is restored after unlocking.
    // eslint-disable-next-line jest/unbound-method
    const originalRead = readable.read;
    const representation = await store.getRepresentation(subjectId, {});

    expect(representation.data).toBe(readable);
    representation.data.read();
    expect(maintainLock).toHaveBeenCalledTimes(1);

    representation.data.destroy();
    await flushPromises();
    expect(readable.read).toBe(originalRead);
    const renewalsAfterClose = maintainLock.mock.calls.length;
    readable.read();
    expect(maintainLock).toHaveBeenCalledTimes(renewalsAfterClose);
  });

  it('acquires the lock on the subject resource when reading an auxiliary resource.', async(): Promise<void> => {
    // Read all data from the representation
    const representation = await store.getRepresentation(auxiliaryId, {});
    representation.data.on('data', (): any => true);
    registerEventOrder(representation.data, 'end');

    // Provide opportunity for async events
    await flushPromises();

    // Verify the lock was acquired and released at the right time
    expect(locker.withReadLock).toHaveBeenCalledTimes(1);
    expect(locker.withReadLock.mock.calls[0][0]).toEqual(subjectId);
    expect(source.getRepresentation).toHaveBeenCalledTimes(1);
    expect(source.getRepresentation).toHaveBeenLastCalledWith(auxiliaryId, {}, undefined);
    expect(order).toEqual([ 'lock read', 'getRepresentation', 'end', 'unlock read' ]);
  });

  it('destroys the resource and releases the lock when the readable errors.', async(): Promise<void> => {
    // Make the representation error
    const representation = await store.getRepresentation(subjectId, {});
    setImmediate((): any => representation.data.emit('error', new Error('Error on the readable')));
    registerEventOrder(representation.data, 'error');
    registerEventOrder(representation.data, 'close');

    // Provide opportunity for async events
    await flushPromises();

    // Verify the lock was acquired and released at the right time
    expect(locker.withReadLock).toHaveBeenCalledTimes(1);
    expect(locker.withReadLock.mock.calls[0][0]).toEqual(subjectId);
    expect(source.getRepresentation).toHaveBeenCalledTimes(1);
    expect(representation.data.destroy).toHaveBeenCalledTimes(1);
    expect(order).toEqual([ 'lock read', 'getRepresentation', 'error', 'unlock read', 'close' ]);
  });

  it('releases the lock on the resource when readable is destroyed.', async(): Promise<void> => {
    // Make the representation close
    const representation = await store.getRepresentation(subjectId, {});
    representation.data.destroy();
    registerEventOrder(representation.data, 'close');

    // Provide opportunity for async events
    await flushPromises();

    // Verify the lock was acquired and released at the right time
    expect(locker.withReadLock).toHaveBeenCalledTimes(1);
    expect(locker.withReadLock.mock.calls[0][0]).toEqual(subjectId);
    expect(source.getRepresentation).toHaveBeenCalledTimes(1);
    expect(order).toEqual([ 'lock read', 'getRepresentation', 'close', 'unlock read' ]);
  });

  it('releases the lock only once when multiple events are triggered.', async(): Promise<void> => {
    // Read all data from the representation and trigger an additional close event
    const representation = await store.getRepresentation(subjectId, {});
    representation.data.on('data', (): any => true);
    representation.data.prependListener('end', (): any => {
      order.push('end');
      representation.data.destroy();
    });

    // Provide opportunity for async events
    await flushPromises();

    // Verify the lock was acquired and released at the right time
    expect(locker.withReadLock).toHaveBeenCalledTimes(1);
    expect(locker.withReadLock.mock.calls[0][0]).toEqual(subjectId);
    expect(source.getRepresentation).toHaveBeenCalledTimes(1);
    expect(order).toEqual([ 'lock read', 'getRepresentation', 'end', 'unlock read' ]);
  });

  it('releases the lock on the resource when readable times out.', async(): Promise<void> => {
    const representation = await store.getRepresentation(subjectId, {});
    registerEventOrder(representation.data, 'close');
    registerEventOrder(representation.data, 'error');

    timeoutTrigger.emit('timeout');

    // Provide opportunity for async events
    await flushPromises();

    // Verify the lock was acquired and released at the right time
    expect(locker.withReadLock).toHaveBeenCalledTimes(1);
    expect(locker.withReadLock.mock.calls[0][0]).toEqual(subjectId);
    expect(source.getRepresentation).toHaveBeenCalledTimes(1);
    expect(representation.data.destroy).toHaveBeenCalledTimes(1);
    expect(representation.data.destroy).toHaveBeenLastCalledWith(new Error('timeout'));
    expect(order).toEqual([ 'lock read', 'getRepresentation', 'timeout', 'unlock read', 'error', 'close' ]);
  });

  it('throws an error if a timeout happens before getting a resource.', async(): Promise<void> => {
    jest.spyOn(source, 'getRepresentation').mockImplementation(async(): Promise<any> => {
      order.push('useless get');
      // This will never resolve
      return new Promise(emptyFn);
    });

    const prom = store.getRepresentation(subjectId, {});

    timeoutTrigger.emit('timeout');

    await expect(prom).rejects.toThrow('timeout');
    expect(locker.withReadLock).toHaveBeenCalledTimes(1);
    expect(locker.withReadLock.mock.calls[0][0]).toEqual(subjectId);
    expect(source.getRepresentation).toHaveBeenCalledTimes(1);
    expect(order).toEqual([ 'lock read', 'useless get', 'timeout', 'unlock read' ]);
  });

  it('destroys a resource stream that arrives after its read lock timed out.', async(): Promise<void> => {
    let resolveRepresentation!: (representation: Representation) => void;
    jest.spyOn(source, 'getRepresentation').mockImplementation((): any => {
      order.push('late get');
      return new Promise((resolve): void => {
        resolveRepresentation = resolve;
      });
    });

    const result = store.getRepresentation(subjectId, {});
    timeoutTrigger.emit('timeout');
    await expect(result).rejects.toThrow('timeout');

    const lateStream = guardedStreamFrom([ 1, 2, 3 ]);
    const destroy = lateStream.destroy.bind(lateStream);
    jest.spyOn(lateStream, 'destroy').mockImplementation((error): any => destroy.call(lateStream, error));
    resolveRepresentation({ data: lateStream } as Representation);
    await flushPromises();

    expect(lateStream.destroy).toHaveBeenCalledTimes(1);
    expect(order).toEqual([ 'lock read', 'late get', 'timeout', 'unlock read' ]);
  });

  it('hasResource should only acquire and release the read lock.', async(): Promise<void> => {
    await store.hasResource(subjectId);
    expect(locker.withReadLock).toHaveBeenCalledTimes(1);
    expect(locker.withWriteLock).toHaveBeenCalledTimes(0);
    expect(source.hasResource).toHaveBeenCalledTimes(1);
    expect(source.hasResource).toHaveBeenLastCalledWith(subjectId);
    expect(order).toEqual([ 'lock read', 'hasResource', 'unlock read' ]);
  });
});
