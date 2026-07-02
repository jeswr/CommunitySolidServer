import { promises as fsPromises } from 'node:fs';
import { ComponentsManager, ConstructionStrategyCommonJsString } from 'componentsjs';
import type { ConfigPrecompilerInput } from '../../../src/init/ConfigPrecompiler';
import { ConfigPrecompiler } from '../../../src/init/ConfigPrecompiler';
import type { Logger } from '../../../src/logging/Logger';
import { getLoggerFor } from '../../../src/logging/LogUtil';

const cliResolverFn = jest.fn();
const appFn = jest.fn();
const artifact = { key: '', cliResolver: cliResolverFn, app: appFn };
const esArtifactWithoutCliResolver = { __esModule: true, key: '', app: appFn };
const esArtifactWithoutApp = { __esModule: true, key: '', cliResolver: cliResolverFn };

let files: Record<string, string> = {};

jest.mock('node:fs', (): any => ({
  existsSync: jest.fn((pth: string): boolean => pth in files),
  promises: {
    readFile: jest.fn(async(pth: string): Promise<string> => {
      if (!(pth in files)) {
        throw new Error(`No file at ${pth}`);
      }
      return files[pth];
    }),
    writeFile: jest.fn(async(pth: string, data: string): Promise<void> => {
      files[pth] = data;
    }),
  },
}));

jest.mock('fs-extra', (): any => ({
  readJson: jest.fn(async(): Promise<any> => ({ version: '9.9.9' })),
}));

jest.mock('../../../src/logging/LogUtil');

const registry = { register: jest.fn() };

const manager = {
  instantiate: jest.fn(async(iri: string): Promise<string> =>
    iri === 'urn:solid-server:default:App' ? 'appVariable' : 'cliVariable'),
};

const strategy = {
  serializeDocument: jest.fn((variable: string): string => `module.exports = '${variable}';`),
};

jest.mock('componentsjs', (): any => ({
  ComponentsManager: {
    build: jest.fn(async(options: any): Promise<any> => {
      await options.configLoader(registry);
      return manager;
    }),
  },
  ConstructionStrategyCommonJsString: jest.fn((): any => strategy),
}));

jest.mock('/artifact.js', (): any => artifact, { virtual: true });
jest.mock('/no-cli-artifact.js', (): any => esArtifactWithoutCliResolver, { virtual: true });
jest.mock('/no-app-artifact.js', (): any => esArtifactWithoutApp, { virtual: true });

describe('A ConfigPrecompiler', (): void => {
  let logger: jest.Mocked<Logger>;
  let input: ConfigPrecompilerInput;
  let precompiler: ConfigPrecompiler;

  beforeEach(async(): Promise<void> => {
    files = {
      '/config/main.json': '{ "import": [ "css:config/extra.json" ] }',
      '/config/other.json': '{}',
    };

    logger = { info: jest.fn(), warn: jest.fn() } as any;
    jest.mocked(getLoggerFor).mockReturnValue(logger);

    input = {
      path: '/artifact.js',
      mainModulePath: '/main/',
      configPaths: [ '/config/main.json', '/config/other.json' ],
    };

    precompiler = new ConfigPrecompiler();
  });

  afterEach((): void => {
    jest.clearAllMocks();
  });

  describe('generating keys', (): void => {
    it('generates a deterministic hexadecimal hash.', async(): Promise<void> => {
      const key = await precompiler.generateKey(input);
      expect(key).toMatch(/^[0-9a-f]{64}$/u);
      await expect(precompiler.generateKey(input)).resolves.toBe(key);
    });

    it('generates a different key if a configuration file changes.', async(): Promise<void> => {
      const key = await precompiler.generateKey(input);
      files['/config/other.json'] = '{ "changed": true }';
      await expect(precompiler.generateKey(input)).resolves.not.toBe(key);
    });

    it('generates a different key for a different main module path.', async(): Promise<void> => {
      const key = await precompiler.generateKey(input);
      input.mainModulePath = '/other/';
      await expect(precompiler.generateKey(input)).resolves.not.toBe(key);
    });
  });

  describe('precompiling', (): void => {
    it('compiles the configurations and writes the artifact.', async(): Promise<void> => {
      await expect(precompiler.precompile(input)).resolves.toBeUndefined();

      expect(ConstructionStrategyCommonJsString).toHaveBeenCalledTimes(1);
      expect(ConstructionStrategyCommonJsString)
        .toHaveBeenLastCalledWith({ asFunction: true, req: expect.any(Function) });
      expect(ComponentsManager.build).toHaveBeenCalledTimes(1);
      expect(ComponentsManager.build).toHaveBeenLastCalledWith({
        mainModulePath: '/main/',
        typeChecking: false,
        constructionStrategy: strategy,
        configLoader: expect.any(Function),
      });
      expect(registry.register).toHaveBeenCalledTimes(2);
      expect(registry.register).toHaveBeenNthCalledWith(1, '/config/main.json');
      expect(registry.register).toHaveBeenNthCalledWith(2, '/config/other.json');
      expect(manager.instantiate).toHaveBeenCalledTimes(2);
      expect(manager.instantiate).toHaveBeenNthCalledWith(1, 'urn:solid-server-app-setup:default:CliResolver');
      expect(manager.instantiate).toHaveBeenNthCalledWith(2, 'urn:solid-server:default:App');
      expect(strategy.serializeDocument).toHaveBeenCalledTimes(2);
      expect(strategy.serializeDocument).toHaveBeenNthCalledWith(1, 'cliVariable');
      expect(strategy.serializeDocument).toHaveBeenNthCalledWith(2, 'appVariable');

      expect(fsPromises.writeFile).toHaveBeenCalledTimes(1);
      expect(fsPromises.writeFile).toHaveBeenLastCalledWith('/artifact.js', expect.any(String), 'utf8');
      const source = files['/artifact.js'];
      expect(source).toContain(`createRequire("/main/package.json")`);
      expect(source).toContain(`key: "${await precompiler.generateKey(input)}",`);
      expect(source).toContain(`cliResolver: load(function(require, module) {\nmodule.exports = 'cliVariable';`);
      expect(source).toContain(`app: load(function(require, module) {\nmodule.exports = 'appVariable';`);

      expect(logger.info).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenLastCalledWith('Wrote a precompiled configuration to /artifact.js');
      expect(logger.warn).toHaveBeenCalledTimes(0);
    });

    it('logs a warning if the configurations can not be compiled.', async(): Promise<void> => {
      jest.mocked(ComponentsManager.build).mockRejectedValueOnce(new Error('bad config'));
      await expect(precompiler.precompile(input)).resolves.toBeUndefined();

      expect(fsPromises.writeFile).toHaveBeenCalledTimes(0);
      expect(logger.info).toHaveBeenCalledTimes(0);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenLastCalledWith(
        'Unable to write a precompiled configuration to /artifact.js: bad config',
      );
    });

    it('logs a warning if the artifact can not be written.', async(): Promise<void> => {
      jest.mocked(fsPromises.writeFile).mockRejectedValueOnce(new Error('read-only'));
      await expect(precompiler.precompile(input)).resolves.toBeUndefined();

      expect(fsPromises.writeFile).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledTimes(0);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenLastCalledWith(
        'Unable to write a precompiled configuration to /artifact.js: read-only',
      );
    });
  });

  describe('loading', (): void => {
    it('returns undefined if there is no artifact.', async(): Promise<void> => {
      input.path = '/missing-artifact.js';
      await expect(precompiler.load(input)).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledTimes(0);
    });

    it('returns the exports of a valid artifact.', async(): Promise<void> => {
      files['/artifact.js'] = 'compiled';
      artifact.key = await precompiler.generateKey(input);
      await expect(precompiler.load(input)).resolves.toBe(artifact);
      expect(logger.warn).toHaveBeenCalledTimes(0);
    });

    it('returns undefined if the artifact key is out of date.', async(): Promise<void> => {
      files['/artifact.js'] = 'compiled';
      artifact.key = 'outdated';
      await expect(precompiler.load(input)).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenLastCalledWith(
        'The precompiled configuration /artifact.js is out of date and will be regenerated.',
      );
    });

    it('returns undefined if the artifact has no cliResolver function.', async(): Promise<void> => {
      input.path = '/no-cli-artifact.js';
      files['/no-cli-artifact.js'] = 'compiled';
      esArtifactWithoutCliResolver.key = await precompiler.generateKey(input);
      await expect(precompiler.load(input)).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenLastCalledWith(
        'The precompiled configuration /no-cli-artifact.js is invalid and will be regenerated.',
      );
    });

    it('returns undefined if the artifact has no app function.', async(): Promise<void> => {
      input.path = '/no-app-artifact.js';
      files['/no-app-artifact.js'] = 'compiled';
      esArtifactWithoutApp.key = await precompiler.generateKey(input);
      await expect(precompiler.load(input)).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenLastCalledWith(
        'The precompiled configuration /no-app-artifact.js is invalid and will be regenerated.',
      );
    });

    it('returns undefined if the artifact can not be imported.', async(): Promise<void> => {
      input.path = '/broken-artifact.js';
      files['/broken-artifact.js'] = 'compiled';
      await expect(precompiler.load(input)).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenLastCalledWith(expect.stringMatching(
        /^Unable to load the precompiled configuration \/broken-artifact\.js: /u,
      ));
    });
  });
});
