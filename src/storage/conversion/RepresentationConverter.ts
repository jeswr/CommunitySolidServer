import type { Representation } from '../../http/representation/Representation';
import type { RepresentationPreferences } from '../../http/representation/RepresentationPreferences';
import type { ResourceIdentifier } from '../../http/representation/ResourceIdentifier';
import { AsyncHandler } from '../../util/handlers/AsyncHandler';

/**
 * Content types that can be used as inputs to satisfy a set of representation preferences.
 *
 * Candidates can contain media ranges when a converter accepts a wildcard input. In that case
 * {@link exhaustive} must be false, since a finite list of physical content types cannot cover the range.
 */
export interface RepresentationConverterInputTypeHints {
  /** Input content types or media ranges, in preferred lookup order. */
  readonly candidates: readonly string[];
  /** Whether the concrete candidates cover every possible input content type. */
  readonly exhaustive: boolean;
}

/** Optional capability for components that can describe acceptable representation inputs. */
export interface RepresentationConverterInputTypeProvider {
  getInputTypeHints?: (preferences: RepresentationPreferences) =>
  Promise<RepresentationConverterInputTypeHints>;
}

export interface RepresentationConverterArgs {
  /**
   * Identifier of the resource. Can be used as base IRI.
   */
  identifier: ResourceIdentifier;
  /**
   * Representation to convert.
   */
  representation: Representation;
  /**
   * Preferences indicating what is requested.
   */
  preferences: RepresentationPreferences;
}

/**
 * Converts a {@link Representation} from one media type to another, based on the given preferences.
 */
export abstract class RepresentationConverter extends AsyncHandler<RepresentationConverterArgs, Representation>
  implements RepresentationConverterInputTypeProvider {
  /**
   * Returns input content types that might satisfy the given output preferences.
   *
   * The default is intentionally non-exhaustive so custom converters remain backwards compatible while callers
   * know that they cannot use the empty candidate list to conclude that no matching representation exists.
   */
  // eslint-disable-next-line unused-imports/no-unused-vars
  public async getInputTypeHints?(preferences: RepresentationPreferences):
  Promise<RepresentationConverterInputTypeHints> {
    return { candidates: [], exhaustive: false };
  }
}
