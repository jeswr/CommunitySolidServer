import type { Credentials } from '../../authentication/Credentials';
import type { PermissionSet } from './Permissions';

/**
 * Reusable `credentialsToCompare` array containing only the public (empty) credential set,
 * used to resolve the public permissions needed for the `WAC-Allow` header
 * alongside an authenticated request's own permissions.
 */
export const PUBLIC_COMPARISON: readonly Credentials[] = Object.freeze([ Object.freeze({}) ]);

/**
 * Symbol under which a {@link PermissionSet} carries the permission sets computed for the
 * {@link PermissionReaderInput.credentialsToCompare} entries, index-aligned with that array.
 * A symbol key is not enumerable through `Object.keys`/`Object.entries` and cannot collide with
 * an {@link AccessMode} key, so attaching comparisons never changes the primary permission semantics.
 */
export const COMPARISON_PERMISSIONS = Symbol('comparisonPermissions');

/**
 * A {@link PermissionSet} that may additionally carry comparison permission sets
 * under the {@link COMPARISON_PERMISSIONS} symbol.
 */
export interface PermissionSetWithComparisons extends PermissionSet {
  [COMPARISON_PERMISSIONS]?: PermissionSet[];
}

/**
 * Reads the comparison permission sets attached to a {@link PermissionSet}, if any.
 *
 * @param permissionSet - The permission set to read from (may be `undefined`).
 *
 * @returns The array of comparison permission sets, or `undefined` if none were attached.
 */
export function getComparisonPermissions(permissionSet?: PermissionSet): PermissionSet[] | undefined {
  return (permissionSet as PermissionSetWithComparisons | undefined)?.[COMPARISON_PERMISSIONS];
}
