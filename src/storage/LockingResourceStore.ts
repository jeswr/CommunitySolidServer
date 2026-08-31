import type { Readable } from 'node:stream';
import type { AuxiliaryIdentifierStrategy } from '../http/auxiliary/AuxiliaryIdentifierStrategy';
import { BasicRepresentation } from '../http/representation/BasicRepresentation';
import type { Patch } from '../http/representation/Patch';
import type { Representation } from '../http/representation/Representation';
import type { RepresentationPreferences } from '../http/representation/RepresentationPreferences';
import type { ResourceIdentifier } from '../http/representation/ResourceIdentifier';
import { getLoggerFor } from '../logging/LogUtil';
import type { ExpiringReadWriteLocker } from '../util/locking/ExpiringReadWriteLocker';
import { endOfStream } from '../util/StreamUtil';
import type { AtomicResourceStore } from './AtomicResourceStore';
import type { Conditions } from './conditions/Conditions';
import type { ChangeMap, ResourceStore } from './ResourceStore';

/**
 * Store that for every call acquires a lock before executing it on the requested resource,
 * and releases it afterwards.
 * In case the request returns a Representation the lock will only be released when the data stream is finished.
 * Similarly, for write operations the lock will be maintained as long as the incoming data stream is being read.
 *
 * For auxiliary resources the lock will be applied to the subject resource.
 * The actual operation is still executed on the auxiliary resource.
 */
export class LockingResourceStore implements AtomicResourceStore {
  protected readonly logger = getLoggerFor(this);

  private readonly source: ResourceStore;
  private readonly locks: ExpiringReadWriteLocker;
  private readonly auxiliaryStrategy: AuxiliaryIdentifierStrategy;

  public constructor(
    source: ResourceStore,
    locks: ExpiringReadWriteLocker,
    auxiliaryStrategy: AuxiliaryIdentifierStrategy,
  ) {
    this.source = source;
    this.locks = locks;
    this.auxiliaryStrategy = auxiliaryStrategy;
  }

  public async hasResource(identifier: ResourceIdentifier): Promise<boolean> {
    return this.locks.withReadLock(
      this.getLockIdentifier(identifier),
      async(): Promise<boolean> => this.source.hasResource(identifier),
    );
  }

  public async getRepresentation(
    identifier: ResourceIdentifier,
    preferences: RepresentationPreferences,
    conditions?: Conditions,
  ): Promise<Representation> {
    return this.lockedRepresentationRun(
      this.getLockIdentifier(identifier),
      'read',
      async(): Promise<Representation> => this.source.getRepresentation(identifier, preferences, conditions),
    );
  }

  public async addResource(
    container: ResourceIdentifier,
    representation: Representation,
    conditions?: Conditions,
  ): Promise<ChangeMap> {
    return this.lockedRepresentationRun(
      this.getLockIdentifier(container),
      'write',
      async(expiringRepresentation): Promise<ChangeMap> =>
        this.source.addResource(container, expiringRepresentation, conditions),
      representation,
    );
  }

  public async setRepresentation(
    identifier: ResourceIdentifier,
    representation: Representation,
    conditions?: Conditions,
  ): Promise<ChangeMap> {
    return this.lockedRepresentationRun(
      this.getLockIdentifier(identifier),
      'write',
      async(expiringRepresentation): Promise<ChangeMap> =>
        this.source.setRepresentation(identifier, expiringRepresentation, conditions),
      representation,
    );
  }

  public async deleteResource(identifier: ResourceIdentifier, conditions?: Conditions): Promise<ChangeMap> {
    return this.locks.withWriteLock(
      this.getLockIdentifier(identifier),
      async(): Promise<ChangeMap> => this.source.deleteResource(identifier, conditions),
    );
  }

  public async modifyResource(
    identifier: ResourceIdentifier,
    patch: Patch,
    conditions?: Conditions,
  ): Promise<ChangeMap> {
    return this.lockedRepresentationRun(
      this.getLockIdentifier(identifier),
      'write',
      async(expiringRepresentation): Promise<ChangeMap> =>
        this.source.modifyResource(identifier, expiringRepresentation, conditions),
      patch,
    );
  }

  /**
   * Acquires the correct identifier to lock this resource.
   * For auxiliary resources this means the subject identifier.
   */
  protected getLockIdentifier(identifier: ResourceIdentifier): ResourceIdentifier {
    return this.auxiliaryStrategy.isAuxiliaryIdentifier(identifier) ?
        this.auxiliaryStrategy.getSubjectIdentifier(identifier) :
      identifier;
  }

  /**
   * Acquires a lock for an operation involving a representation.
   * For reads, the lock is only released when all resulting data has been read,
   * an error occurs, or the timeout has been triggered.
   * For writes, the lock is held until the operation completes.
   * In both cases the representation is adapted to reset the timer every time data is read.
   *
   * In case the data of the resulting stream is not needed it should be closed to prevent a timeout error.
   *
   * @param identifier - Identifier that should be locked.
   * @param lockType - Type of lock that should be acquired.
   * @param whileLocked - Function to be executed while the resource is locked.
   * @param inputRepresentation - Representation to pass to a write operation.
   */
  protected lockedRepresentationRun(
    identifier: ResourceIdentifier,
    lockType: 'read',
    whileLocked: () => Promise<Representation>,
  ): Promise<Representation>;
  protected lockedRepresentationRun<T>(
    identifier: ResourceIdentifier,
    lockType: 'write',
    whileLocked: (representation: Representation) => Promise<T>,
    inputRepresentation: Representation,
  ): Promise<T>;
  protected async lockedRepresentationRun<T>(
    identifier: ResourceIdentifier,
    lockType: 'read' | 'write',
    whileLocked: (() => Promise<Representation>) | ((representation: Representation) => Promise<T>),
    inputRepresentation?: Representation,
  ): Promise<Representation | T> {
    // Create a new Promise that resolves to the resulting Representation
    // while only unlocking when the data has been read (or there's a timeout).
    // Note that we can't just return the result of `withReadLock` since that promise only
    // resolves when the stream is finished, while we want `lockedRepresentationRun` to resolve
    // once we have the Representation.
    // See https://github.com/CommunitySolidServer/CommunitySolidServer/pull/536#discussion_r562467957
    return new Promise((resolve, reject): void => {
      let representation: Representation | undefined;
      let operationActive = false;
      const runWhileLocked = async(maintainLock: () => void): Promise<T | void> => {
        operationActive = true;
        try {
          if (lockType === 'write') {
            // The write overload requires an input representation.
            representation = inputRepresentation!;
            const expiringRepresentation = this.createExpiringRepresentation(representation, maintainLock);
            return await (whileLocked as (representation: Representation) => Promise<T>)(expiringRepresentation);
          }

          representation = await (whileLocked as () => Promise<Representation>)();
          resolve(this.createExpiringRepresentation(representation, maintainLock));

          // Release the lock when an error occurs or the data finished streaming
          await this.waitForStreamToEnd(representation.data);
        } finally {
          operationActive = false;
        }
      };

      // Make the resource time out to ensure that the lock is always released eventually.
      const lock = lockType === 'read' ?
          this.locks.withReadLock(identifier, runWhileLocked) :
          this.locks.withWriteLock(identifier, runWhileLocked);
      lock.then((result): void => {
        if (lockType === 'write') {
          resolve(result as T);
        }
      }).catch((error: unknown): void => {
        // Destroy the source stream when an acquired lock expires while the operation is still active.
        // This prevents a source store from continuing a write without the protection of the lock.
        if (operationActive) {
          representation?.data.destroy(error as Error);
        }

        // Let this function return an error in case something went wrong getting the data,
        // or in case the lock expired before the operation completed.
        reject(error as Error);
      });
    });
  }

  /**
   * Wraps a representation to make it reset the timeout timer every time data is read.
   *
   * @param representation - The representation to wrap
   * @param maintainLock - Function to call to reset the timer.
   */
  protected createExpiringRepresentation(representation: Representation, maintainLock: () => void): Representation {
    const source = representation.data;
    // Spy on the source to maintain the lock upon reading.
    const data = Object.create(source, {
      read: {
        value(size: number): unknown {
          maintainLock();
          return source.read(size);
        },
      },
    }) as Readable;
    return new BasicRepresentation(data, representation.metadata, representation.binary);
  }

  /**
   * Returns a promise that resolve when the source stream is finished,
   * either by ending or emitting an error.
   * In the case of an error the stream will be destroyed if it hasn't been already.
   *
   * @param source - The input stream.
   */
  protected async waitForStreamToEnd(source: Readable): Promise<void> {
    try {
      await endOfStream(source);
    } catch {
      // Destroy the stream in case of errors
      if (!source.destroyed) {
        source.destroy();
      }
    }
  }
}
