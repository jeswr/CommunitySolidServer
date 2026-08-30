import { getAuthorizationStorageHints } from '../../../src/authorization/AuthorizationStorageHints';
import { RdfValidator } from '../../../src/http/auxiliary/RdfValidator';
import { ChainedConverter } from '../../../src/storage/conversion/ChainedConverter';
import { DynamicJsonToTemplateConverter } from '../../../src/storage/conversion/DynamicJsonToTemplateConverter';
import { MarkdownToHtmlConverter } from '../../../src/storage/conversion/MarkdownToHtmlConverter';
import { getRdfInputTypes } from '../../../src/storage/conversion/RdfParserUtil';
import { RdfToQuadConverter } from '../../../src/storage/conversion/RdfToQuadConverter';
import type { RepresentationConverter } from '../../../src/storage/conversion/RepresentationConverter';
import { WaterfallConverter } from '../../../src/storage/conversion/WaterfallConverter';
import { APPLICATION_JSON, INTERNAL_QUADS, TEXT_MARKDOWN, TEXT_TURTLE } from '../../../src/util/ContentTypes';

describe('Authorization storage hints', (): void => {
  it('exhaustively covers direct and indirect RDF inputs, preferring Turtle.', async(): Promise<void> => {
    const templateEngine = {} as any;
    const converter = new WaterfallConverter([
      new DynamicJsonToTemplateConverter(templateEngine),
      new ChainedConverter([
        new RdfToQuadConverter(),
        new MarkdownToHtmlConverter(templateEngine),
      ]),
    ]);
    const validator = new RdfValidator(converter);
    const hintsPromise = getAuthorizationStorageHints(validator);
    const hints = await hintsPromise;
    const inputHints = await validator.getInputTypeHints({ type: { [INTERNAL_QUADS]: 1 }});
    const rdfInputTypes = await getRdfInputTypes();

    expect(hints.contentType?.exhaustive).toBe(true);
    expect(hints.contentType?.candidates[0]).toBe(TEXT_TURTLE);
    expect(new Set(hints.contentType?.candidates)).toEqual(new Set(inputHints.candidates));
    expect(hints.contentType?.candidates).toEqual(expect.arrayContaining([
      ...Object.keys(rdfInputTypes),
      TEXT_MARKDOWN,
      APPLICATION_JSON,
      INTERNAL_QUADS,
    ]));
    expect(Object.isFrozen(hints)).toBe(true);
    expect(Object.isFrozen(hints.contentType)).toBe(true);
    expect(Object.isFrozen(hints.contentType?.candidates)).toBe(true);
    await expect(getAuthorizationStorageHints(validator)).resolves.toBe(hints);
  });

  it('preserves discovery for legacy converters that do not expose their inputs.', async(): Promise<void> => {
    const converter = {} as RepresentationConverter;
    await expect(getAuthorizationStorageHints(converter)).resolves.toEqual({
      contentType: { candidates: [], exhaustive: false },
    });
  });
});
