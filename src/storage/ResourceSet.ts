import type { ResourceIdentifier } from '../http/representation/ResourceIdentifier';

/** Information about the physical content type under which a document might be stored. */
export interface ContentTypeStorageHints {
  /** Content types used to derive possible physical paths, in lookup order. */
  readonly candidates: readonly string[];
  /**
   * Whether the paths derived from the candidates cover every possible physical location for the resource.
   * Content types alone do not imply this: MIME aliases can map a stored extension back to a different media type.
   */
  readonly exhaustive: boolean;
}

/**
 * Optional information about how a resource might be stored in the underlying source.
 * These values are physical lookup hints, not representation preferences. Implementations may ignore them, but must
 * return the same logical result as an unhinted lookup. A truthfully exhaustive hint allows implementations to
 * conclude that a resource is missing once every candidate path has been checked.
 */
export interface ResourceStorageHints {
  readonly contentType?: ContentTypeStorageHints;
}

/**
 * A set containing resources.
 */
export interface ResourceSet {
  /**
   * Checks whether a resource exists in this ResourceSet.
   *
   * @param identifier - Identifier of resource to check.
   * @param hints - Optional details that can optimize how the resource is found in the source.
   *
   * @returns A promise resolving if the resource already exists.
   */
  hasResource: (identifier: ResourceIdentifier, hints?: ResourceStorageHints) => Promise<boolean>;
}
