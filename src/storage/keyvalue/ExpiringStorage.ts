import type { KeyValueStorage } from './KeyValueStorage';

/* eslint-disable @typescript-eslint/method-signature-style */
/**
 * A KeyValueStorage in which the values can expire.
 * Entries with no expiration date never expire.
 */
export interface ExpiringStorage<TKey, TValue> extends KeyValueStorage<TKey, TValue> {
  /**
   * Sets the value for the given key.
   * Should error if the data is already expired.
   *
   * @param key - Key to set/update.
   * @param value - Value to store.
   * @param expiration - How long this data should stay valid in milliseconds.
   *
   * @returns The storage.
   */
  set(key: TKey, value: TValue, expiration?: number): Promise<this>;

  /**
   * Sets the value for the given key.
   * Should error if the data is already expired.
   *
   * @param key - Key to set/update.
   * @param value - Value to store.
   * @param expires - When this value expires. Never if undefined.
   *
   * @returns The storage.
   */
  set(key: TKey, value: TValue, expires?: Date): Promise<this>;

  /**
   * Returns the expiration date of the value stored under the given key, if any.
   * Returns `undefined` if there is no entry for the key,
   * if the entry has already expired,
   * or if the entry has no expiration date.
   *
   * This method is optional:
   * callers need to check for its presence and fall back to behaviour that does not need the expiration date.
   *
   * @param key - Key to check.
   *
   * @returns The expiration date of the corresponding entry, if any.
   */
  getExpiration?(key: TKey): Promise<Date | undefined>;
}
