import type { ValuePreferences } from '../../http/representation/RepresentationPreferences';
import { RepresentationConverter } from './RepresentationConverter';

/**
 * A {@link RepresentationConverter} that allows requesting the supported types.
 */
export abstract class TypedRepresentationConverter extends RepresentationConverter {
  /**
   * Gets the input content types or media ranges supported by this converter.
   *
   * An empty result indicates that the converter does not expose its supported inputs.
   */
  public async getInputTypes(): Promise<ValuePreferences> {
    return {};
  }

  /**
   * Gets the output content types this converter can convert the input type to, mapped to a numerical priority.
   */
  public abstract getOutputTypes(contentType: string): Promise<ValuePreferences>;
}
