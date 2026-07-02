import { existsSync } from 'node:fs';
import type { WriteStream } from 'node:tty';
import type { IComponentsManagerBuilderOptions } from 'componentsjs';
import { ComponentsManager } from 'componentsjs';
import { readJSON } from 'fs-extra';
import yargs from 'yargs';
import { LOG_LEVELS } from '../logging/LogLevel';
import { getLoggerFor } from '../logging/LogUtil';
import { createErrorMessage, isError } from '../util/errors/ErrorUtil';
import { InternalServerError } from '../util/errors/InternalServerError';
import { joinFilePath, resolveAssetPath, resolveModulePath } from '../util/PathUtil';
import type { App } from './App';
import type { CliExtractor } from './cli/CliExtractor';
import type { CliResolver } from './CliResolver';
import { listSingleThreadedComponents } from './cluster/SingleThreaded';
import type { ConfigPrecompilerInput, PrecompiledConfig } from './ConfigPrecompiler';
import { ConfigPrecompiler } from './ConfigPrecompiler';
import type { ShorthandResolver } from './variables/ShorthandResolver';
import type { CliArgv, Shorthand, VariableBindings } from './variables/Types';

const DEFAULT_CONFIG = resolveModulePath('config/default.json');

const DEFAULT_CLI_RESOLVER = 'urn:solid-server-app-setup:default:CliResolver';
const DEFAULT_APP = 'urn:solid-server:default:App';

const CORE_CLI_PARAMETERS = {
  config: { type: 'array', alias: 'c', default: [ DEFAULT_CONFIG ], requiresArg: true },
  loggingLevel: { type: 'string', alias: 'l', default: 'info', requiresArg: true, choices: LOG_LEVELS },
  mainModulePath: { type: 'string', alias: 'm', requiresArg: true },
  precompiledConfigPath: { type: 'string', requiresArg: true },
} as const;

const ENV_VAR_PREFIX = 'CSS';

/**
 * Parameters that can be used to instantiate the server through code.
 */
export interface AppRunnerInput {
  /**
   * Properties that will be used when building the Components.js manager.
   * Default values:
   *  - `typeChecking`: `false`, as the server components would otherwise error.
   *  - `mainModulePath`: `@css:`, which resolves to the directory of the CSS package.
   *                      This is useful for packages that depend on the CSS
   *                      but do not create any new modules themselves.
   */
  loaderProperties?: Partial<IComponentsManagerBuilderOptions<App>>;
  /**
   * Path to the server config file(s). Defaults to `@css:config/default.json`.
   */
  config?: string | string[];
  /**
   * Values to apply to the Components.js variables.
   * These are the variables CLI values will be converted to.
   * The keys should be the variable URIs.
   * E.g.: `{ 'urn:solid-server:default:variable:rootFilePath': '.data' }`.
   */
  variableBindings?: VariableBindings;
  /**
   * CLI argument names and their corresponding values.
   * E.g.: `{ rootFilePath: '.data' }`.
   * Abbreviated parameter names can not be used, so `{ f: '.data' }` would not work.
   *
   * In case both `shorthand` and `variableBindings` have entries that would result in a value for the same variable,
   * `variableBindings` has priority.
   */
  shorthand?: Shorthand;
  /**
   * An array containing CLI arguments passed to start the process.
   * Entries here have the lowest priority for assigning values to variables.
   */
  argv?: string[];
  /**
   * Path to a file where a precompiled version of the configuration(s) is stored,
   * allowing the server to start without having to parse any modules or configurations.
   * If there is no such file yet, or if it is out of date,
   * the server starts normally and afterwards writes the precompiled configuration to this path,
   * so it can be used to speed up future server starts.
   *
   * Note that changes to configuration files imported by the top-level configuration(s) can not be detected,
   * so after such changes this file needs to be deleted manually to force a new compilation.
   * Multithreaded setups are not supported:
   * for those the file is ignored and the server always starts normally.
   */
  precompiledConfigPath?: string;
}

/**
 * A class that can be used to instantiate and start a server based on a Component.js configuration.
 */
export class AppRunner {
  private readonly logger = getLoggerFor(this);
  private readonly precompiler = new ConfigPrecompiler();

  /**
   * Starts the server with a given config.
   *
   * @param input - All values necessary to configure the server.
   */
  public async run(input: AppRunnerInput): Promise<void> {
    const app = await this.create(input);
    await app.start();
  }

  /**
   * Returns an App object, created with the given config, that can start and stop the Solid server.
   *
   * @param input - All values necessary to configure the server.
   */
  public async create(input: AppRunnerInput = {}): Promise<App> {
    const loaderProperties = {
      typeChecking: false,
      mainModulePath: '@css:',
      dumpErrorState: false,
      ...input.loaderProperties,
    };
    // Expand mainModulePath as needed
    loaderProperties.mainModulePath = resolveAssetPath(loaderProperties.mainModulePath);

    // Potentially expand config paths as needed
    let configs = input.config ?? [ '@css:config/default.json' ];
    configs = (Array.isArray(configs) ? configs : [ configs ]).map(resolveAssetPath);

    if (input.precompiledConfigPath) {
      return this.createPrecompiled({
        path: resolveAssetPath(input.precompiledConfigPath),
        mainModulePath: loaderProperties.mainModulePath,
        configPaths: configs,
      }, loaderProperties, configs, input);
    }

    return this.createFromConfigs(loaderProperties, configs, input);
  }

  /**
   * Creates an App by having Components.js build and instantiate the given configurations.
   *
   * @param loaderProperties - Properties used when building the Components.js manager.
   * @param configs - The resolved configuration paths.
   * @param input - All values necessary to configure the server.
   */
  private async createFromConfigs(
    loaderProperties: IComponentsManagerBuilderOptions<App>,
    configs: string[],
    input: AppRunnerInput,
  ): Promise<App> {
    let componentsManager: ComponentsManager<App | CliResolver>;
    try {
      componentsManager = await this.createComponentsManager<App>(loaderProperties, configs);
    } catch (error: unknown) {
      this.resolveError(`Could not build the config files from ${configs.join(',')}`, error);
    }

    const cliResolver = await this.createCliResolver(componentsManager as ComponentsManager<CliResolver>);
    const variables = await this.resolveVariables(cliResolver, input);

    return this.createApp(componentsManager as ComponentsManager<App>, variables);
  }

  /**
   * Creates an App from the precompiled configuration in the given artifact, if possible.
   * Falls back to {@link AppRunner.createFromConfigs} if there is no valid artifact,
   * in which case the artifact also gets (re)generated to speed up future server starts,
   * or if the resolved variables imply a multithreaded setup.
   *
   * @param precompilerInput - Determines the artifact location and the values used to verify its key.
   * @param loaderProperties - Properties used when building the Components.js manager, in case of a fallback.
   * @param configs - The resolved configuration paths.
   * @param input - All values necessary to configure the server.
   */
  private async createPrecompiled(
    precompilerInput: ConfigPrecompilerInput,
    loaderProperties: IComponentsManagerBuilderOptions<App>,
    configs: string[],
    input: AppRunnerInput,
  ): Promise<App> {
    const precompiled = await this.precompiler.load(precompilerInput);
    if (precompiled) {
      const app = await this.createPrecompiledApp(precompiled, input, precompilerInput.path);
      if (app) {
        return app;
      }
      // Multithreaded setups require a Components.js manager for the thread safety check,
      // so those fall back to a full build without regenerating the artifact.
      return this.createFromConfigs(loaderProperties, configs, input);
    }

    const app = await this.createFromConfigs(loaderProperties, configs, input);
    this.logger.info(`Precompiling the configuration to ${precompilerInput.path} to speed up future server starts`);
    await this.precompiler.precompile(precompilerInput);
    return app;
  }

  /**
   * Creates an App using the instantiation functions of a precompiled configuration,
   * without any Components.js involvement.
   * Returns `undefined` if the result would run multithreaded,
   * as verifying thread safety requires a Components.js manager.
   *
   * @param precompiled - The precompiled configuration.
   * @param input - All values necessary to configure the server.
   * @param path - Path of the artifact the precompiled configuration was loaded from.
   */
  private async createPrecompiledApp(precompiled: PrecompiledConfig, input: AppRunnerInput, path: string):
  Promise<App | undefined> {
    let cliResolver: CliResolver;
    try {
      cliResolver = precompiled.cliResolver({});
    } catch (error: unknown) {
      this.resolveError(`Could not create the CLI resolver from the precompiled configuration ${path}`, error);
    }

    const variables = await this.resolveVariables(cliResolver, input);

    let app: App;
    try {
      app = precompiled.app(variables);
    } catch (error: unknown) {
      this.resolveError(`Could not create the server from the precompiled configuration ${path}`, error);
    }

    if (!app.clusterManager.isSingleThreaded()) {
      this.logger.warn(`Precompiled configurations can not be used in multithreaded setups. Ignoring ${path}.`);
      return;
    }

    this.logger.info(`Created the server from the precompiled configuration ${path}`);
    return app;
  }

  /**
   * Determines the variable values by extracting shorthand values from the CLI arguments, if any,
   * and resolving those together with the shorthand input.
   * Values from the `variableBindings` input override the resolved values.
   *
   * @param cliResolver - {@link CliResolver} used to extract and resolve shorthand values.
   * @param input - All values necessary to configure the server.
   */
  private async resolveVariables(cliResolver: CliResolver, input: AppRunnerInput): Promise<VariableBindings> {
    let extracted: Shorthand = {};
    if (input.argv) {
      extracted = await this.extractShorthand(cliResolver.cliExtractor, input.argv);
    }
    const parsedVariables = await this.resolveShorthand(cliResolver.shorthandResolver, {
      ...extracted,
      ...input.shorthand,
    });

    // `variableBindings` override those resolved from the `shorthand` input.
    return { ...parsedVariables, ...input.variableBindings };
  }

  /**
   * Starts the server as a command-line application.
   * Will exit the process on failure.
   *
   * Made non-async to lower the risk of unhandled promise rejections.
   * This is only relevant when this is used to start as a Node.js application on its own,
   * if you use this as part of your code you probably want to use the async version.
   *
   * @param argv - Input parameters.
   * @param argv.argv - Command line arguments.
   * @param argv.stderr - Stream that should be used to output errors before the logger is enabled.
   */
  public runCliSync({ argv, stderr = process.stderr }: { argv?: CliArgv; stderr?: WriteStream }): void {
    this.runCli(argv).catch((error: unknown): never => {
      stderr.write(createErrorMessage(error));
      // eslint-disable-next-line unicorn/no-process-exit
      process.exit(1);
    });
  }

  /**
   * Starts the server as a command-line application.
   *
   * @param argv - Command line arguments.
   */
  public async runCli(argv?: CliArgv): Promise<void> {
    const app = await this.createCli(argv);
    try {
      await app.start();
    } catch (error: unknown) {
      this.logger.error(`Could not start the server: ${createErrorMessage(error)}`);
      this.resolveError('Could not start the server', error);
    }
  }

  /**
   * Returns an App object, created by parsing the Command line arguments, that can start and stop the Solid server.
   * Will exit the process on failure.
   *
   * @param argv - Command line arguments.
   */
  public async createCli(argv: CliArgv = process.argv): Promise<App> {
    // Parse only the core CLI arguments needed to load the configuration
    let yargv = yargs(argv.slice(2))
      .usage('node ./bin/server.js [args]')
      .options(CORE_CLI_PARAMETERS)
      // We disable help here as it would only show the core parameters
      .help(false)
      // We also read from environment variables
      .env(ENV_VAR_PREFIX);

    const settings = await this.getPackageSettings();
    if (typeof settings !== 'undefined') {
      yargv = yargv.default<object>(settings);
    }

    const params = await yargv.parse();

    const loaderProperties: AppRunnerInput['loaderProperties'] = {
      mainModulePath: params.mainModulePath,
      logLevel: params.loggingLevel,
    };

    return this.create({
      loaderProperties,
      config: params.config as string[],
      argv,
      shorthand: settings,
      precompiledConfigPath: params.precompiledConfigPath,
    });
  }

  /**
   * Retrieves settings from package.json or configuration file when
   * part of an npm project.
   *
   * @returns The settings defined in the configuration file
   */
  public async getPackageSettings(): Promise<undefined | Record<string, unknown>> {
    // Only try and retrieve config file settings if there is a package.json in the
    // scope of the current directory
    const packageJsonPath = joinFilePath(process.cwd(), 'package.json');
    if (!existsSync(packageJsonPath)) {
      return;
    }

    // First see if there is a dedicated .json configuration file
    const cssConfigPath = joinFilePath(process.cwd(), '.community-solid-server.config.json');
    if (existsSync(cssConfigPath)) {
      return readJSON(cssConfigPath) as Promise<Record<string, unknown>>;
    }

    // Next see if there is a dedicated .js file
    const cssConfigPathJs = joinFilePath(process.cwd(), '.community-solid-server.config.js');
    if (existsSync(cssConfigPathJs)) {
      return import(cssConfigPathJs) as Promise<Record<string, unknown>>;
    }

    // Finally try to read from the config.community-solid-server
    // field in the root package.json
    const pkg = await readJSON(packageJsonPath) as { config?: Record<string, unknown> };
    if (typeof pkg.config?.['community-solid-server'] === 'object') {
      return pkg.config['community-solid-server'] as Record<string, unknown>;
    }
  }

  /**
   * Creates the Components Manager that will be used for instantiating.
   */
  public async createComponentsManager<T>(
    loaderProperties: IComponentsManagerBuilderOptions<T>,
    configs: string[],
  ): Promise<ComponentsManager<T>> {
    const componentsManager = await ComponentsManager.build(loaderProperties);
    for (const config of configs) {
      await componentsManager.configRegistry.register(config);
    }
    return componentsManager;
  }

  /**
   * Instantiates the {@link CliResolver}.
   */
  private async createCliResolver(componentsManager: ComponentsManager<CliResolver>): Promise<CliResolver> {
    try {
      // Create a CliResolver, which combines a CliExtractor and a VariableResolver
      return await componentsManager.instantiate(DEFAULT_CLI_RESOLVER, {});
    } catch (error: unknown) {
      this.resolveError(`Could not create the CLI resolver`, error);
    }
  }

  /**
   * Uses the {@link CliExtractor} to convert the CLI args to a {@link Shorthand} object.
   */
  private async extractShorthand(cliExtractor: CliExtractor, argv: CliArgv): Promise<Shorthand> {
    try {
      // Convert CLI args to CLI bindings
      return await cliExtractor.handleSafe(argv);
    } catch (error: unknown) {
      this.resolveError(`Could not parse the CLI parameters`, error);
    }
  }

  /**
   * Uses the {@link ShorthandResolver} to convert {@link Shorthand} to {@link VariableBindings} .
   */
  private async resolveShorthand(shorthandResolver: ShorthandResolver, shorthand: Shorthand):
  Promise<VariableBindings> {
    try {
      // Convert CLI bindings into variable bindings
      return await shorthandResolver.handleSafe(shorthand);
    } catch (error: unknown) {
      this.resolveError(`Could not resolve the shorthand values`, error);
    }
  }

  /**
   * The second Components.js instantiation,
   * where the App is created and started using the variable mappings.
   */
  private async createApp(componentsManager: ComponentsManager<App>, variables: Record<string, unknown>): Promise<App> {
    let app: App;
    // Create the app
    try {
      app = await componentsManager.instantiate(DEFAULT_APP, { variables });
    } catch (error: unknown) {
      this.resolveError(`Could not create the server`, error);
    }

    // Ensure thread safety
    if (!app.clusterManager.isSingleThreaded()) {
      const violatingClasses = await listSingleThreadedComponents(componentsManager);
      if (violatingClasses.length > 0) {
        const verb = violatingClasses.length > 1 ? 'are' : 'is';
        const detailedError = new InternalServerError(
          `[${violatingClasses.join(', ')}] ${verb} not threadsafe and should not be run in multithreaded setups!`,
        );
        this.resolveError('Cannot run a singlethreaded-only component in a multithreaded setup!', detailedError);
      }
    }
    return app;
  }

  /**
   * Throws a new error that provides additional information through the extra message.
   * Also appends the stack trace to the message.
   * This is needed for errors that are thrown before the logger is created as we can't log those the standard way.
   */
  private resolveError(message: string, error: unknown): never {
    const errorMessage = `${message}\n${isError(error) ? error.stack : createErrorMessage(error)}\n`;
    throw new Error(errorMessage);
  }
}
