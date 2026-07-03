import { createHash } from 'node:crypto';
import { promises as fsPromises } from 'node:fs';
import type { IModuleState } from 'componentsjs';
import { getLoggerFor } from '../logging/LogUtil';
import { createErrorMessage } from '../util/errors/ErrorUtil';
import { joinFilePath, readPackageJson } from '../util/PathUtil';

/**
 * Counter combined with the process id to generate unique temporary file names,
 * ensuring concurrent writes never target the same temporary path.
 */
let tempCounter = 0;

/**
 * The contents of a module state cache file.
 */
interface ModuleStateCacheEntry {
  /**
   * Key identifying the environment in which the module state was generated.
   */
  key: string;
  /**
   * The cached module state.
   */
  moduleState: IModuleState;
}

/**
 * Caches a Components.js {@link IModuleState} as JSON on disk,
 * allowing subsequent server starts to skip the expensive scan of all `node_modules` directories.
 *
 * Cache entries contain a key identifying the environment in which they were generated.
 * This key is a SHA-256 hash of the server version, the Node.js version, the main module path,
 * and the contents of the `package-lock.json` file in the main module path.
 * If there is no such file, the contents of the `package.json` file in the main module path are used instead.
 * A cached module state only gets reused if its key matches that of the current environment,
 * otherwise the stale cache file gets removed.
 */
export class ModuleStateCache {
  private readonly logger = getLoggerFor(this);

  private readonly path: string;
  private readonly mainModulePath: string;
  private key: string | undefined;

  /**
   * @param path - Path of the file in which the module state gets cached.
   * @param mainModulePath - The main module path used when building the Components.js manager.
   */
  public constructor(path: string, mainModulePath: string) {
    this.path = path;
    this.mainModulePath = mainModulePath;
  }

  /**
   * Loads the module state from the cache.
   * Invalid or stale cache files get removed.
   * Never throws: all errors result in a cache miss.
   *
   * @returns The cached module state, or `undefined` if there is no valid cache entry.
   */
  public async load(): Promise<IModuleState | undefined> {
    let raw: string;
    try {
      raw = await fsPromises.readFile(this.path, 'utf8');
    } catch {
      this.logger.debug(`Unable to read module state cache from ${this.path}`);
      return;
    }

    let entry: ModuleStateCacheEntry | null;
    try {
      entry = JSON.parse(raw) as ModuleStateCacheEntry | null;
    } catch (error: unknown) {
      // The cache file is corrupt and can never become valid again, so it gets removed.
      this.logger.warn(`Removing corrupt module state cache at ${this.path}: ${createErrorMessage(error)}`);
      await this.remove();
      return;
    }

    let key: string;
    try {
      key = await this.getKey();
    } catch (error: unknown) {
      // Computing the key can fail because of transient environment issues,
      // such as a temporarily missing or unreadable package-lock.json or package.json.
      // The cached entry might still be valid, so it is treated as a miss without being removed.
      this.logger.warn(
        `Unable to compute the module state cache key, ignoring cache at ${this.path}: ${createErrorMessage(error)}`,
      );
      return;
    }

    if (entry?.key !== key) {
      this.logger.debug(`Removing stale module state cache at ${this.path}`);
      await this.remove();
      return;
    }

    this.logger.debug(`Reusing cached module state from ${this.path}`);
    return entry.moduleState;
  }

  /**
   * Writes the given module state to the cache,
   * together with the key of the current environment.
   * Never throws: a warning gets logged if writing fails.
   *
   * @param moduleState - The module state to cache.
   */
  public async save(moduleState: IModuleState): Promise<void> {
    // Use a temporary file name that is unique per process and per call so concurrent writes
    // from multiple server instances never target the same temporary file and corrupt each other.
    const nonce = tempCounter;
    tempCounter += 1;
    const tempPath = `${this.path}.${process.pid}.${Date.now()}.${nonce}.tmp`;
    try {
      const entry: ModuleStateCacheEntry = { key: await this.getKey(), moduleState };
      // Write to a temporary file first so an existing cache file does not get corrupted
      // in case an error occurs halfway through the write.
      await fsPromises.writeFile(tempPath, JSON.stringify(entry), 'utf8');
      // Best-effort removal of the destination before renaming: on some platforms (notably Windows)
      // `rename` does not reliably overwrite an existing file.
      await this.remove();
      await fsPromises.rename(tempPath, this.path);
      this.logger.debug(`Stored module state in ${this.path}`);
    } catch (error: unknown) {
      this.logger.warn(`Unable to write module state cache to ${this.path}: ${createErrorMessage(error)}`);
      // Best-effort cleanup so a failed write does not leave the unique temporary file behind.
      await this.remove(tempPath);
    }
  }

  /**
   * Generates the key identifying the current environment.
   * The result is cached so it only gets computed once.
   */
  private async getKey(): Promise<string> {
    if (!this.key) {
      const pkg = await readPackageJson();
      this.key = createHash('sha256')
        .update(`${pkg.version as string}\n${process.version}\n${this.mainModulePath}\n`)
        .update(await this.readDependencies())
        .digest('hex');
    }
    return this.key;
  }

  /**
   * Reads the contents of the `package-lock.json` file in the main module path,
   * falling back to the `package.json` file if there is no lock file.
   */
  private async readDependencies(): Promise<string> {
    try {
      return await fsPromises.readFile(joinFilePath(this.mainModulePath, 'package-lock.json'), 'utf8');
    } catch {
      return fsPromises.readFile(joinFilePath(this.mainModulePath, 'package.json'), 'utf8');
    }
  }

  /**
   * Removes the given file, ignoring any errors.
   *
   * @param path - Path of the file to remove. Defaults to the cache file path.
   */
  private async remove(path: string = this.path): Promise<void> {
    try {
      await fsPromises.unlink(path);
    } catch {
      this.logger.debug(`Unable to remove file at ${path}`);
    }
  }
}
