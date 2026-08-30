import type { Representation } from '../../../../src/http/representation/Representation';
import type { RepresentationPreferences } from '../../../../src/http/representation/RepresentationPreferences';
import { PassthroughConverter } from '../../../../src/storage/conversion/PassthroughConverter';
import { RepresentationConverter } from '../../../../src/storage/conversion/RepresentationConverter';
import type {
  RepresentationConverterArgs,
  RepresentationConverterInputTypeHints,
} from '../../../../src/storage/conversion/RepresentationConverter';
import { WaterfallConverter } from '../../../../src/storage/conversion/WaterfallConverter';
import { NotImplementedHttpError } from '../../../../src/util/errors/NotImplementedHttpError';

class HintConverter extends RepresentationConverter {
  private readonly hints: RepresentationConverterInputTypeHints;
  private readonly supported: boolean;
  private readonly output: Representation;

  public constructor(hints: RepresentationConverterInputTypeHints, supported: boolean, output: Representation) {
    super();
    this.hints = hints;
    this.supported = supported;
    this.output = output;
  }

  public async getInputTypeHints(): Promise<RepresentationConverterInputTypeHints> {
    return this.hints;
  }

  public async canHandle(): Promise<void> {
    if (!this.supported) {
      throw new NotImplementedHttpError();
    }
  }

  public async handle(): Promise<Representation> {
    return this.output;
  }
}

describe('A WaterfallConverter', (): void => {
  const preferences: RepresentationPreferences = { type: { 'target/type': 1 }};
  const args = { preferences } as RepresentationConverterArgs;

  it('combines and deduplicates exhaustive member hints.', async(): Promise<void> => {
    const converter = new WaterfallConverter([
      new HintConverter({ candidates: [ 'a/a', 'b/b' ], exhaustive: true }, true, {} as Representation),
      new HintConverter({ candidates: [ 'b/b', 'c/c' ], exhaustive: true }, true, {} as Representation),
    ]);

    await expect(converter.getInputTypeHints(preferences)).resolves.toEqual({
      candidates: [ 'a/a', 'b/b', 'c/c' ],
      exhaustive: true,
    });
  });

  it('filters wildcard declarations and remains non-exhaustive for unknown members.', async(): Promise<void> => {
    const converter = new WaterfallConverter([
      new HintConverter({ candidates: [ 'a/*', 'a/a' ], exhaustive: false }, true, {} as Representation),
      new PassthroughConverter(),
    ]);

    await expect(converter.getInputTypeHints(preferences)).resolves.toEqual({
      candidates: [ 'a/a' ],
      exhaustive: false,
    });
  });

  it('preserves discovery for legacy members that do not expose their inputs.', async(): Promise<void> => {
    const legacy = {
      canHandle: jest.fn(),
      handle: jest.fn(),
    } as unknown as RepresentationConverter;
    const converter = new WaterfallConverter([ legacy ]);

    await expect(converter.getInputTypeHints(preferences)).resolves.toEqual({
      candidates: [],
      exhaustive: false,
    });
  });

  it('preserves waterfall selection behaviour.', async(): Promise<void> => {
    const expected = {} as Representation;
    const unsupported = new HintConverter({ candidates: [], exhaustive: true }, false, {} as Representation);
    const supported = new HintConverter({ candidates: [], exhaustive: true }, true, expected);
    const converter = new WaterfallConverter([ unsupported, supported ]);
    jest.spyOn(unsupported, 'handle');
    jest.spyOn(supported, 'handle');

    await expect(converter.canHandle(args)).resolves.toBeUndefined();
    await expect(converter.handle(args)).resolves.toBe(expected);
    await expect(converter.handleSafe(args)).resolves.toBe(expected);
    expect(unsupported.handle).not.toHaveBeenCalled();
    expect(supported.handle).toHaveBeenCalledTimes(2);
  });
});
