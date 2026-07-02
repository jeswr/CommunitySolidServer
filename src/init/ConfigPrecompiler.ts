import { createHash } from 'node:crypto';
import { existsSync, promises as fsPromises } from 'node:fs';
import { createRequire } from 'node:module';
import type { ConfigRegistry } from 'componentsjs';
import { ComponentsManager, ConstructionStrategyCommonJsString } from 'componentsjs';
import { getLoggerFor } from '../logging/LogUtil';
import { createErrorMessage } from '../util/errors/ErrorUtil';
import { joinFilePath, readPackageJson } from '../util/PathUtil';
import type { App } from './App';
import type { CliResolver } from './CliResolver';

const DEFAULT_CLI_RESOLVER = 'urn:solid-server-app-setup:default:CliResolver';
const DEFAULT_APP = 'urn:solid-server:default:App';

/**
 * The values needed to precompile a configuration or load the resulting artifact.
 */
export interface ConfigPrecompilerInput {
  /**
   * Path of the JavaScript artifact containing the precompiled configuration.
   */
  path: string;
  /**
   * The resolved path Components.js uses as entry point when resolving modules.
   */
  mainModulePath: string;
  /**
   * The resolved paths of the top-level configuration files.
   */
  configPaths: string[];
}

/**
 * The exports of a precompiled configuration artifact.
 */
export interface PrecompiledConfig {
  /**
   * The key that was generated when the artifact was written,
   * used to detect artifacts that are out of date.
   */
  key: string;
  /**
   * Instantiates the {@link CliResolver} of the configuration.
   *
   * @param variables - Values for the Components.js variables the configuration references.
   */
  cliResolver: (variables?: Record<string, unknown>) => CliResolver;
  /**
   * Instantiates the {@link App} of the configuration.
   *
   * @param variables - Values for the Components.js variables the configuration references.
   */
  app: (variables: Record<string, unknown>) => App;
}

/**
 * Compiles Components.js configurations into a single JavaScript artifact
 * that can instantiate the {@link CliResolver} and the {@link App}
 * without having to parse any modules or configurations,
 * significantly reducing server startup time.
 * The artifact is a CommonJS module with the exports described in {@link PrecompiledConfig}.
 *
 * To detect artifacts that are out of date,
 * the artifact also exports a key generated from the server version, the Node.js version,
 * the main module path, and the paths and contents of the top-level configuration files.
 * Configurations imported by those files are not part of the key,
 * so changes to such transitively imported configuration files can not be detected:
 * in that case the artifact file needs to be deleted manually to force a new compilation.
 */
export class ConfigPrecompiler {
  protected readonly logger = getLoggerFor(this);

  /**
   * Compiles the given configurations into a single JavaScript artifact,
   * written to the path in the input.
   * Errors are logged instead of thrown,
   * as a server that failed to write this optimization can keep functioning without it.
   *
   * @param input - Determines the configurations to compile and where the result is written.
   */
  public async precompile(input: ConfigPrecompilerInput): Promise<void> {
    try {
      const key = await this.generateKey(input);
      // Compiled instantiations of components in the main module get emitted
      // as `require` calls relative to the main module path,
      // so the artifact resolves them with a `require` scoped to that directory.
      const req = createRequire(joinFilePath(input.mainModulePath, 'package.json'));
      const strategy = new ConstructionStrategyCommonJsString({ asFunction: true, req });
      const manager = await ComponentsManager.build<string>({
        mainModulePath: input.mainModulePath,
        typeChecking: false,
        constructionStrategy: strategy,
        configLoader: async(registry: ConfigRegistry): Promise<void> => {
          for (const configPath of input.configPaths) {
            await registry.register(configPath);
          }
        },
      });
      // With the above construction strategy,
      // `instantiate` returns the name of the variable containing the instance in the compiled source
      const cliVariable = await manager.instantiate(DEFAULT_CLI_RESOLVER);
      const cliSource = strategy.serializeDocument(cliVariable);
      const appVariable = await manager.instantiate(DEFAULT_APP);
      const appSource = strategy.serializeDocument(appVariable);
      await fsPromises.writeFile(input.path, this.serializeArtifact(key, input, cliSource, appSource), 'utf8');
      this.logger.info(`Wrote a precompiled configuration to ${input.path}`);
    } catch (error: unknown) {
      this.logger.warn(`Unable to write a precompiled configuration to ${input.path}: ${createErrorMessage(error)}`);
    }
  }

  /**
   * Loads a precompiled configuration artifact.
   * Returns `undefined` if there is no artifact at the path in the input,
   * or if the artifact is invalid or out of date,
   * in which case the caller is expected to fall back to a full Components.js instantiation.
   *
   * @param input - Determines the artifact location and the values used to verify its key.
   */
  public async load(input: ConfigPrecompilerInput): Promise<PrecompiledConfig | undefined> {
    if (!existsSync(input.path)) {
      return;
    }
    try {
      const imported = await import(input.path) as PrecompiledConfig & { default?: PrecompiledConfig };
      const artifact = imported.default ?? imported;
      if (artifact.key !== await this.generateKey(input)) {
        this.logger.warn(`The precompiled configuration ${input.path} is out of date and will be regenerated.`);
        return;
      }
      if (typeof artifact.cliResolver !== 'function' || typeof artifact.app !== 'function') {
        this.logger.warn(`The precompiled configuration ${input.path} is invalid and will be regenerated.`);
        return;
      }
      return artifact;
    } catch (error: unknown) {
      this.logger.warn(`Unable to load the precompiled configuration ${input.path}: ${createErrorMessage(error)}`);
    }
  }

  /**
   * Generates the key used to detect precompiled configurations that are out of date.
   * This is a hash of the server version, the Node.js version, the main module path,
   * and the paths and contents of the top-level configuration files.
   *
   * @param input - The values that determine the compilation result.
   */
  public async generateKey(input: ConfigPrecompilerInput): Promise<string> {
    const pkg = await readPackageJson();
    const hash = createHash('sha256');
    hash.update(`${pkg.version as string}\n${process.version}\n${input.mainModulePath}\n`);
    for (const configPath of input.configPaths) {
      hash.update(`${configPath}\n`);
      hash.update(await fsPromises.readFile(configPath, 'utf8'));
      hash.update('\n');
    }
    return hash.digest('hex');
  }

  /**
   * Combines the compiled sources into the source of a module with the {@link PrecompiledConfig} exports.
   * Each compiled source is a standalone CommonJS module,
   * so they get wrapped in functions providing scoped `require` and `module` values.
   *
   * @param key - Key used to detect artifacts that are out of date.
   * @param input - The input that was used to compile the sources.
   * @param cliSource - Compiled source of the {@link CliResolver} instantiation.
   * @param appSource - Compiled source of the {@link App} instantiation.
   */
  protected serializeArtifact(key: string, input: ConfigPrecompilerInput, cliSource: string, appSource: string):
  string {
    return [
      '// Precompiled Community Solid Server configuration.',
      `// This file was generated from [ ${input.configPaths.join(', ')} ] and should not be edited.`,
      `'use strict';`,
      `const { createRequire } = require('node:module');`,
      `const contextRequire = createRequire(${JSON.stringify(joinFilePath(input.mainModulePath, 'package.json'))});`,
      'function load(factory) {',
      '  const module = { exports: {} };',
      '  factory(contextRequire, module);',
      '  return module.exports;',
      '}',
      'module.exports = {',
      `  key: ${JSON.stringify(key)},`,
      '  cliResolver: load(function(require, module) {',
      cliSource,
      '  }),',
      '  app: load(function(require, module) {',
      appSource,
      '  }),',
      '};',
      '',
    ].join('\n');
  }
}
