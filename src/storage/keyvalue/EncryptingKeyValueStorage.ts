import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { createErrorMessage } from '../../util/errors/ErrorUtil';
import type { KeyValueStorage } from './KeyValueStorage';
import { PassthroughKeyValueStorage } from './PassthroughKeyValueStorage';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
// A fixed salt so the same secret derives the same key across restarts, keeping earlier writes decryptable
const KEY_SALT = 'community-solid-server:storage-encryption:v1';

/**
 * The shape in which an {@link EncryptingKeyValueStorage} stores encrypted values in its source.
 * The `encrypted` marker distinguishes envelopes from plaintext values written before encryption was enabled.
 */
interface EncryptedEnvelope {
  encrypted: true;
  /** Base64-encoded initialization vector. */
  iv: string;
  /** Base64-encoded GCM authentication tag. */
  tag: string;
  /** Base64-encoded ciphertext of the JSON-serialized value. */
  value: string;
}

/**
 * Determines whether a stored value is an {@link EncryptedEnvelope} rather than a plaintext value.
 */
function isEncryptedEnvelope(value: unknown): value is EncryptedEnvelope {
  return typeof value === 'object' && value !== null && (value as { encrypted?: unknown }).encrypted === true;
}

/**
 * A {@link KeyValueStorage} wrapper that transparently encrypts its values at rest with AES-256-GCM,
 * so a leak of the underlying storage does not expose secrets such as the OIDC signing key.
 * Keys are not modified. Values that are not encrypted envelopes are returned unchanged,
 * so plaintext values written before encryption was enabled stay readable
 * and are encrypted the next time they are written.
 */
export class EncryptingKeyValueStorage<TVal> extends PassthroughKeyValueStorage<TVal> {
  private readonly cryptoKey: Buffer;

  /**
   * @param source - The storage in which the encrypted values will be stored.
   * @param key - The secret passphrase from which the encryption key is derived.
   */
  public constructor(source: KeyValueStorage<string, TVal>, key?: string) {
    super(source);
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error(
        `Storage encryption is enabled but no encryption key was provided. Set the storageEncryptionKey ` +
        `variable through the --storageEncryptionKey CLI argument or the CSS_STORAGE_ENCRYPTION_KEY ` +
        `environment variable.`,
      );
    }
    this.cryptoKey = scryptSync(key, KEY_SALT, KEY_LENGTH);
  }

  public async get(key: string): Promise<TVal | undefined> {
    const stored = await this.valueSource.get(this.toNewKey(key));
    if (stored === undefined) {
      return undefined;
    }
    return this.decode(stored);
  }

  public async set(key: string, value: TVal): Promise<this> {
    await this.valueSource.set(this.toNewKey(key), this.encrypt(value));
    return this;
  }

  public async* entries(): AsyncIterableIterator<[string, TVal]> {
    for await (const [ key, stored ] of this.valueSource.entries()) {
      yield [ this.toOriginalKey(key), this.decode(stored) ];
    }
  }

  protected toNewKey(key: string): string {
    return key;
  }

  protected toOriginalKey(key: string): string {
    return key;
  }

  /**
   * A typed view of the wrapped storage, which holds {@link EncryptedEnvelope} objects
   * or plaintext values rather than the `TVal` exposed to callers.
   */
  private get valueSource(): KeyValueStorage<string, unknown> {
    return this.source as unknown as KeyValueStorage<string, unknown>;
  }

  private decode(stored: unknown): TVal {
    if (isEncryptedEnvelope(stored)) {
      return this.decrypt(stored);
    }
    // A plaintext value written before encryption was enabled
    return stored as TVal;
  }

  private encrypt(value: TVal): EncryptedEnvelope {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.cryptoKey, iv);
    const ciphertext = Buffer.concat([ cipher.update(JSON.stringify(value), 'utf-8'), cipher.final() ]);
    return {
      encrypted: true,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      value: ciphertext.toString('base64'),
    };
  }

  private decrypt(envelope: EncryptedEnvelope): TVal {
    try {
      const decipher = createDecipheriv(ALGORITHM, this.cryptoKey, Buffer.from(envelope.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.value, 'base64')),
        decipher.final(),
      ]);
      return JSON.parse(plaintext.toString('utf-8')) as TVal;
    } catch (error: unknown) {
      throw new Error(
        `Unable to decrypt a stored value. The encryption passphrase may be incorrect ` +
        `or the stored data may be corrupted. ${createErrorMessage(error)}`,
      );
    }
  }
}
