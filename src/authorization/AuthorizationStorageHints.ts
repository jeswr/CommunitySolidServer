import type { RepresentationConverterInputTypeProvider } from '../storage/conversion/RepresentationConverter';
import type { ResourceStorageHints } from '../storage/ResourceSet';
import { INTERNAL_QUADS, TEXT_TURTLE } from '../util/ContentTypes';

const CACHE = new WeakMap<RepresentationConverterInputTypeProvider, Promise<ResourceStorageHints>>();

async function createAuthorizationStorageHints(provider: RepresentationConverterInputTypeProvider):
Promise<ResourceStorageHints> {
  const inputHints = await provider.getInputTypeHints?.({ type: { [INTERNAL_QUADS]: 1 }}) ??
    { candidates: [], exhaustive: false };
  const uniqueCandidates = [ ...new Set(inputHints.candidates) ];
  const candidates = Object.freeze([
    ...uniqueCandidates.filter((type): boolean => type === TEXT_TURTLE),
    ...uniqueCandidates.filter((type): boolean => type !== TEXT_TURTLE),
  ]);

  return Object.freeze({
    contentType: Object.freeze({
      candidates,
      // Authorization writes use this same validator. Out-of-band corruption is outside this lookup contract.
      exhaustive: inputHints.exhaustive,
    }),
  });
}

/**
 * Returns physical lookup hints covering every format accepted by the authorization validator.
 */
export async function getAuthorizationStorageHints(provider: RepresentationConverterInputTypeProvider):
Promise<ResourceStorageHints> {
  let result = CACHE.get(provider);
  if (!result) {
    result = createAuthorizationStorageHints(provider);
    CACHE.set(provider, result);
  }
  return result;
}
