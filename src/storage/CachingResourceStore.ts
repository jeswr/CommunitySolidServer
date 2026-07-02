import type { Quad } from '@rdfjs/types';
import arrayifyStream from 'arrayify-stream';
import type { AuxiliaryIdentifierStrategy } from '../http/auxiliary/AuxiliaryIdentifierStrategy';
import { BasicRepresentation } from '../http/representation/BasicRepresentation';
import type { Patch } from '../http/representation/Patch';
import type { Representation } from '../http/representation/Representation';
import { RepresentationMetadata } from '../http/representation/RepresentationMetadata';
import type { RepresentationPreferences } from '../http/representation/RepresentationPreferences';
import type { ResourceIdentifier } from '../http/representation/ResourceIdentifier';
import type { SingleThreaded } from '../init/cluster/SingleThreaded';
import { INTERNAL_QUADS } from '../util/ContentTypes';
import { guardedStreamFrom } from '../util/StreamUtil';
import type { Conditions } from './conditions/Conditions';
import { PassthroughStore } from './PassthroughStore';
import type { ChangeMap, ResourceStore } from './ResourceStore';

/**
 * A cached representation: a frozen array of quads and a snapshot of the metadata.
 */
interface RepresentationCacheEntry {
  quads: readonly Quad[];
  metadata: RepresentationMetadata;
  expires: number;
}

/**
 * A cached existence result.
 */
interface ExistenceCacheEntry {
  value: boolean;
  expires: number;
}

/**
 * Tuning parameters for the {@link CachingResourceStore}.
 */
export interface CachingResourceStoreOptions {
  /**
   * Time in milliseconds an entry remains valid.
   * Doubles as the kill switch: a value of `0` (or lower) disables all caching, turning this into a pure passthrough.
   */
  ttl?: number;
  /**
   * Maximum number of cached representations before the least-recently-used one is evicted.
   */
  maxEntries?: number;
  /**
   * Maximum total number of cached quads across all representations.
   */
  maxQuads?: number;
  /**
   * Maximum number of quads in a single document; larger documents are served but never stored.
   */
  maxQuadsPerDoc?: number;
  /**
   * Maximum number of cached existence results before the least-recently-used one is evicted.
   */
  maxHasEntries?: number;
}

/**
 * A {@link ResourceStore} wrapper that caches, across requests, the quad representations and existence results
 * of auxiliary (by default ACL) documents.
 *
 * This store MUST be positioned directly below the store that emits change events (the `MonitoringStore`)
 * and above the rest of the stack: it invalidates its cache synchronously from the {@link ChangeMap} returned
 * by every write, so a read that happens after a write (and any notification-driven authorization) always sees
 * fresh data. Because invalidation is driven purely by that `ChangeMap`, all writes MUST flow through this
 * wrapper; a store that mutates ACL data while bypassing this wrapper would leave the cache stale.
 *
 * Correctness of access control is non-negotiable, so every failure mode degrades to a cache miss and never to
 * stale data: oversized documents are served but not stored, and a write landing while a read is in flight
 * prevents that read from populating the cache (via a per-key generation counter).
 *
 * The class is {@link SingleThreaded}: its cache lives in process memory and is invalidated through in-process
 * events only, so a multi-worker setup would not share invalidations and could serve stale authorization data.
 * The marker makes multi-worker boot fail fast.
 */
export class CachingResourceStore<T extends ResourceStore = ResourceStore>
  extends PassthroughStore<T> implements SingleThreaded {
  private readonly cacheStrategy: AuxiliaryIdentifierStrategy;
  private readonly ttl: number;
  private readonly maxEntries: number;
  private readonly maxQuads: number;
  private readonly maxQuadsPerDoc: number;
  private readonly maxHasEntries: number;

  private readonly reps: Map<string, RepresentationCacheEntry>;
  private readonly has: Map<string, ExistenceCacheEntry>;
  private readonly generations: Map<string, number>;
  private readonly inFlight: Map<string, Promise<{ quads: Quad[]; metadata: RepresentationMetadata }>>;
  private totalQuads: number;

  /**
   * @param source - The store whose ACL reads and existence checks are being cached.
   * @param cacheStrategy - Strategy identifying which resources are cacheable auxiliary (ACL) documents.
   *                        Injecting the ACP `.acr` strategy instead of the WAC `.acl` strategy reuses this store
   *                        for ACP without any code change.
   * @param options - Cache tuning parameters. See {@link CachingResourceStoreOptions}.
   */
  public constructor(
    source: T,
    cacheStrategy: AuxiliaryIdentifierStrategy,
    options: CachingResourceStoreOptions = {},
  ) {
    super(source);
    this.cacheStrategy = cacheStrategy;
    this.ttl = options.ttl ?? 30000;
    this.maxEntries = options.maxEntries ?? 500;
    this.maxQuads = options.maxQuads ?? 20000;
    this.maxQuadsPerDoc = options.maxQuadsPerDoc ?? 2000;
    this.maxHasEntries = options.maxHasEntries ?? 5000;

    this.reps = new Map();
    this.has = new Map();
    this.generations = new Map();
    this.inFlight = new Map();
    this.totalQuads = 0;
  }

  public async getRepresentation(
    identifier: ResourceIdentifier,
    preferences: RepresentationPreferences,
    conditions?: Conditions,
  ): Promise<Representation> {
    if (!this.isCacheableRead(identifier, preferences, conditions)) {
      return this.source.getRepresentation(identifier, preferences, conditions);
    }

    const key = identifier.path;
    const entry = this.reps.get(key);
    if (entry) {
      if (entry.expires > Date.now()) {
        // Re-insert to mark as most-recently-used.
        this.reps.delete(key);
        this.reps.set(key, entry);
        return this.buildRepresentation(entry.quads, entry.metadata);
      }
      this.removeRep(key);
    }

    const materialized = await this.readAndMaterialize(key, identifier, preferences, conditions);
    return this.buildRepresentation(materialized.quads, materialized.metadata);
  }

  public async hasResource(identifier: ResourceIdentifier): Promise<boolean> {
    if (this.ttl <= 0 || !this.cacheStrategy.isAuxiliaryIdentifier(identifier)) {
      return this.source.hasResource(identifier);
    }

    const key = identifier.path;
    const entry = this.has.get(key);
    if (entry) {
      if (entry.expires > Date.now()) {
        // Re-insert to mark as most-recently-used.
        this.has.delete(key);
        this.has.set(key, entry);
        return entry.value;
      }
      this.has.delete(key);
    }

    const generation = this.generationOf(key);
    const value = await this.source.hasResource(identifier);
    // Only store if no write invalidated this key while the check was in flight (else degrade to a miss).
    if (this.generationOf(key) === generation) {
      this.has.set(key, { value, expires: Date.now() + this.ttl });
      this.enforceHasBounds();
    }
    return value;
  }

  public async addResource(
    container: ResourceIdentifier,
    representation: Representation,
    conditions?: Conditions,
  ): Promise<ChangeMap> {
    const changes = await super.addResource(container, representation, conditions);
    this.invalidate(changes);
    return changes;
  }

  public async setRepresentation(
    identifier: ResourceIdentifier,
    representation: Representation,
    conditions?: Conditions,
  ): Promise<ChangeMap> {
    const changes = await super.setRepresentation(identifier, representation, conditions);
    this.invalidate(changes);
    return changes;
  }

  public async modifyResource(
    identifier: ResourceIdentifier,
    patch: Patch,
    conditions?: Conditions,
  ): Promise<ChangeMap> {
    const changes = await super.modifyResource(identifier, patch, conditions);
    this.invalidate(changes);
    return changes;
  }

  public async deleteResource(
    identifier: ResourceIdentifier,
    conditions?: Conditions,
  ): Promise<ChangeMap> {
    const changes = await super.deleteResource(identifier, conditions);
    this.invalidate(changes);
    return changes;
  }

  /**
   * Determines whether a read can be served from / stored in the cache.
   * Only exact quad reads (`{ type: { 'internal/quads': 1 } }`) of an auxiliary resource, without conditions
   * or range, are cacheable. Anything else is pure passthrough.
   *
   * @param identifier - Identifier being read.
   * @param preferences - Preferences of the read.
   * @param conditions - Conditions of the read.
   */
  private isCacheableRead(
    identifier: ResourceIdentifier,
    preferences: RepresentationPreferences,
    conditions?: Conditions,
  ): boolean {
    if (this.ttl <= 0 || conditions || !this.cacheStrategy.isAuxiliaryIdentifier(identifier)) {
      return false;
    }
    return this.isQuadsOnlyPreferences(preferences);
  }

  /**
   * Checks that the preferences are exactly `{ type: { 'internal/quads': 1 } }` and nothing else,
   * so any additional dimension (charset, range, ...) makes the read non-cacheable.
   *
   * @param preferences - Preferences to check.
   */
  private isQuadsOnlyPreferences(preferences: RepresentationPreferences): boolean {
    const keys = Object.keys(preferences);
    if (keys.length !== 1 || keys[0] !== 'type') {
      return false;
    }
    const type = preferences.type!;
    const typeKeys = Object.keys(type);
    return typeKeys.length === 1 && type[INTERNAL_QUADS] === 1;
  }

  /**
   * Reads a representation from the source and materializes its quads, deduplicating concurrent misses on the
   * same key (single-flight). The per-key generation counter is snapshotted before the source is contacted and
   * re-checked at commit time, so a write that lands during the read prevents caching of the raced value.
   *
   * @param key - Cache key (the identifier path).
   * @param identifier - Identifier being read.
   * @param preferences - Preferences of the read.
   * @param conditions - Conditions of the read.
   */
  private async readAndMaterialize(
    key: string,
    identifier: ResourceIdentifier,
    preferences: RepresentationPreferences,
    conditions?: Conditions,
  ): Promise<{ quads: Quad[]; metadata: RepresentationMetadata }> {
    const existing = this.inFlight.get(key);
    if (existing) {
      return existing;
    }

    const generation = this.generationOf(key);
    const promise = this.fetchAndStore(key, identifier, preferences, conditions, generation);
    this.inFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(key);
    }
  }

  /**
   * Fetches the representation from the source, materializes its quads, and stores it if it is not oversized
   * and no write invalidated the key while the read was in flight.
   *
   * @param key - Cache key (the identifier path).
   * @param identifier - Identifier being read.
   * @param preferences - Preferences of the read.
   * @param conditions - Conditions of the read.
   * @param generation - Generation counter snapshotted before the source was contacted.
   */
  private async fetchAndStore(
    key: string,
    identifier: ResourceIdentifier,
    preferences: RepresentationPreferences,
    conditions: Conditions | undefined,
    generation: number,
  ): Promise<{ quads: Quad[]; metadata: RepresentationMetadata }> {
    const representation = await this.source.getRepresentation(identifier, preferences, conditions);
    const quads = await arrayifyStream<Quad>(representation.data);
    const { metadata } = representation;

    if (quads.length <= this.maxQuadsPerDoc && this.generationOf(key) === generation) {
      this.storeRepresentation(key, quads, metadata);
    }
    return { quads, metadata };
  }

  /**
   * Builds a fresh representation from cached data: a new stream over the frozen quads and a clone of the
   * metadata, so callers can never mutate what is stored.
   *
   * @param quads - The cached quads.
   * @param metadata - The cached metadata to clone.
   */
  private buildRepresentation(quads: readonly Quad[], metadata: RepresentationMetadata): Representation {
    return new BasicRepresentation(guardedStreamFrom(quads), new RepresentationMetadata(metadata, INTERNAL_QUADS));
  }

  /**
   * Stores a representation in the cache, freezing its quads, and enforces the size bounds.
   *
   * @param key - Cache key (the identifier path).
   * @param quads - The materialized quads.
   * @param metadata - The source metadata.
   */
  private storeRepresentation(key: string, quads: Quad[], metadata: RepresentationMetadata): void {
    this.removeRep(key);
    this.reps.set(key, { quads: Object.freeze(quads), metadata, expires: Date.now() + this.ttl });
    this.totalQuads += quads.length;
    this.enforceRepBounds();
  }

  /**
   * Removes a representation from the cache, keeping the total quad count in sync.
   *
   * @param key - Cache key (the identifier path).
   */
  private removeRep(key: string): void {
    const entry = this.reps.get(key);
    if (entry) {
      this.totalQuads -= entry.quads.length;
      this.reps.delete(key);
    }
  }

  /**
   * Evicts least-recently-used representations until the entry and total quad bounds are satisfied.
   */
  private enforceRepBounds(): void {
    while (this.reps.size > this.maxEntries || this.totalQuads > this.maxQuads) {
      this.removeRep(this.reps.keys().next().value as string);
    }
  }

  /**
   * Evicts least-recently-used existence results until the bound is satisfied.
   */
  private enforceHasBounds(): void {
    while (this.has.size > this.maxHasEntries) {
      this.has.delete(this.has.keys().next().value as string);
    }
  }

  /**
   * Invalidates every key touched by a write, regardless of its activity metadata, plus the auxiliary
   * identifier of each key (belt-and-braces cascade so a subject write also drops its ACL document).
   * This never throws, so a write can never succeed while leaving the cache stale.
   *
   * @param changes - The {@link ChangeMap} returned by the write.
   */
  private invalidate(changes: ChangeMap): void {
    if (this.ttl <= 0) {
      return;
    }
    for (const [ identifier ] of changes) {
      this.invalidateKey(identifier.path);
      this.invalidateKey(this.cacheStrategy.getAuxiliaryIdentifier(identifier).path);
    }
  }

  /**
   * Drops the cached representation and existence result for a single key and bumps its generation counter,
   * closing the window on any read that is currently in flight for that key.
   *
   * @param key - Cache key (the identifier path).
   */
  private invalidateKey(key: string): void {
    this.removeRep(key);
    this.has.delete(key);
    this.generations.set(key, this.generationOf(key) + 1);
  }

  /**
   * Returns the current generation counter for a key (`0` if it was never invalidated).
   *
   * @param key - Cache key (the identifier path).
   */
  private generationOf(key: string): number {
    return this.generations.get(key) ?? 0;
  }
}
