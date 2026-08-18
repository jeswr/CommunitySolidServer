import { readFileSync } from 'node:fs';
import { getPresetConfigPath } from '../../../integration/Config';

interface ProviderConfig {
  features: { registration: Record<string, unknown> };
  [key: string]: unknown;
}

function readConfig(configFile: string): Record<string, any> {
  return JSON.parse(readFileSync(getPresetConfigPath(configFile), 'utf8')) as Record<string, any>;
}

describe('The restricted registration provider factory config', (): void => {
  const defaultConfig = readConfig('identity/handler/base/provider-factory.json');
  const restrictedConfig = readConfig('identity/handler/base/provider-factory-restricted-registration.json');

  const defaultProviderConfig = defaultConfig['@graph'][0].config as ProviderConfig;
  const override = restrictedConfig['@graph'][0];
  const restrictedProviderConfig = override.overrideParameters.config as ProviderConfig;

  it('is an Override targeting the default IdentityProviderFactory instance.', (): void => {
    expect(override['@type']).toBe('Override');
    expect(override.overrideInstance['@id']).toBe('urn:solid-server:default:IdentityProviderFactory');
    expect(override.overrideParameters['@type']).toBe('IdentityProviderFactory');
  });

  it('keeps registration open by default.', (): void => {
    expect(defaultProviderConfig.features.registration).toEqual({ enabled: true });
  });

  it('only adds an initial access token requirement when opted in.', (): void => {
    expect(restrictedProviderConfig.features.registration).toEqual({ enabled: true, initialAccessToken: true });
  });

  it('changes nothing else about the provider configuration.', (): void => {
    // Neutralize the one intended difference, then require deep equality with the default.
    const restrictedWithoutRegistration = structuredClone(restrictedProviderConfig);
    restrictedWithoutRegistration.features.registration = defaultProviderConfig.features.registration;
    expect(restrictedWithoutRegistration).toEqual(defaultProviderConfig);
  });
});
