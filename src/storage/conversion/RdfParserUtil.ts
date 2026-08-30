import rdfParser from 'rdf-parse';
import type { ValuePreferences } from '../../http/representation/RepresentationPreferences';
import { APPLICATION_JSON } from '../../util/ContentTypes';

const RDF_INPUT_TYPES = rdfParser.getContentTypesPrioritized()
  .then((types): ValuePreferences => {
    const inputTypes = { ...types };
    // Generic JSON is ambiguous and is not necessarily JSON-LD.
    delete inputTypes[APPLICATION_JSON];
    return inputTypes;
  });

/**
 * Returns the content types that the RDF parser can convert to quads.
 */
export async function getRdfInputTypes(): Promise<ValuePreferences> {
  return { ...await RDF_INPUT_TYPES };
}
