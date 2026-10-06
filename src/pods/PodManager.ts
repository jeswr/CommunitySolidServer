import type { ResourceIdentifier } from '../http/representation/ResourceIdentifier';
import type { PodSettings } from './settings/PodSettings';

/**
 * Covers all functions related to pod management.
 * In the future this should also include recovery functions.
 */
export interface PodManager {
  /**
   * Creates a pod for the given settings.
   *
   * @param settings - Settings describing the pod.
   * @param overwrite - If the creation should proceed if there already is a resource there.
   */
  createPod: (settings: PodSettings, overwrite: boolean) => Promise<void>;

  /**
   * Deletes the pod with the given base identifier, including all the resources it contains.
   * Optional: managers that do not implement this do not support deleting pods.
   *
   * @param base - Base identifier of the pod.
   */
  deletePod?: (base: ResourceIdentifier) => Promise<void>;
}
