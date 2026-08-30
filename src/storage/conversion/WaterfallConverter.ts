import type { Representation } from '../../http/representation/Representation';
import type { RepresentationPreferences } from '../../http/representation/RepresentationPreferences';
import { WaterfallHandler } from '../../util/handlers/WaterfallHandler';
import { RepresentationConverter } from './RepresentationConverter';
import type {
  RepresentationConverterArgs,
  RepresentationConverterInputTypeHints,
} from './RepresentationConverter';

/**
 * A conversion-specific waterfall that also exposes the inputs supported by its members.
 */
export class WaterfallConverter extends RepresentationConverter {
  private readonly handlers: RepresentationConverter[];
  private readonly source: WaterfallHandler<RepresentationConverterArgs, Representation>;

  public constructor(handlers: RepresentationConverter[]) {
    super();
    this.handlers = [ ...handlers ];
    this.source = new WaterfallHandler(this.handlers);
  }

  public async getInputTypeHints(preferences: RepresentationPreferences):
  Promise<RepresentationConverterInputTypeHints> {
    const results = await Promise.all(this.handlers.map(async(handler):
    Promise<RepresentationConverterInputTypeHints> =>
      handler.getInputTypeHints?.(preferences) ?? { candidates: [], exhaustive: false }));
    const candidates = new Set<string>();
    let exhaustive = true;

    for (const result of results) {
      exhaustive = exhaustive && result.exhaustive;
      for (const candidate of result.candidates) {
        if (candidate.includes('*')) {
          exhaustive = false;
        } else {
          candidates.add(candidate);
        }
      }
    }

    return { candidates: [ ...candidates ], exhaustive };
  }

  public async canHandle(input: RepresentationConverterArgs): Promise<void> {
    return this.source.canHandle(input);
  }

  public async handle(input: RepresentationConverterArgs): Promise<Representation> {
    return this.source.handle(input);
  }

  public async handleSafe(input: RepresentationConverterArgs): Promise<Representation> {
    return this.source.handleSafe(input);
  }
}
