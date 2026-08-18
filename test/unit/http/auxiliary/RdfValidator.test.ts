import { Readable } from 'node:stream';
import { RdfValidator } from '../../../../src/http/auxiliary/RdfValidator';
import { BasicRepresentation } from '../../../../src/http/representation/BasicRepresentation';
import type { ResourceIdentifier } from '../../../../src/http/representation/ResourceIdentifier';
import type { RepresentationConverter } from '../../../../src/storage/conversion/RepresentationConverter';
import { PayloadHttpError } from '../../../../src/util/errors/PayloadHttpError';
import { guardStream } from '../../../../src/util/GuardedStream';
import { readableToString } from '../../../../src/util/StreamUtil';
import { StaticAsyncHandler } from '../../../util/StaticAsyncHandler';
import 'jest-rdf';

describe('An RdfValidator', (): void => {
  let converter: RepresentationConverter;
  let validator: RdfValidator;
  const identifier: ResourceIdentifier = { path: 'any/path' };

  beforeEach(async(): Promise<void> => {
    converter = new StaticAsyncHandler<any>(true, null);
    validator = new RdfValidator(converter);
  });

  it('can handle all representations.', async(): Promise<void> => {
    await expect(validator.canHandle(null as any)).resolves.toBeUndefined();
  });

  it('always accepts content-type internal/quads.', async(): Promise<void> => {
    const representation = new BasicRepresentation('data', 'internal/quads');
    await expect(validator.handle({ representation, identifier })).resolves.toEqual(representation);
  });

  it('validates data by running it through a converter.', async(): Promise<void> => {
    jest.spyOn(converter, 'handleSafe').mockResolvedValue(new BasicRepresentation('transformedData', 'wrong/type'));
    const representation = new BasicRepresentation('data', 'content/type');
    const quads = representation.metadata.quads();
    // Output is not important for this Validator
    await expect(validator.handle({ representation, identifier })).resolves.toBeDefined();
    // Make sure the data can still be streamed
    await expect(readableToString(representation.data)).resolves.toBe('data');
    // Make sure the metadata was not changed
    expect(quads).toBeRdfIsomorphic(representation.metadata.quads());
  });

  it('throws an error when validating invalid data.', async(): Promise<void> => {
    jest.spyOn(converter, 'handleSafe').mockRejectedValue(new Error('bad data!'));
    const representation = new BasicRepresentation('data', 'content/type');
    await expect(validator.handle({ representation, identifier })).rejects.toThrow('bad data!');
    // Make sure the data on the readable has not been reset
    expect(representation.data.destroyed).toBe(true);
  });

  it('validates a document that stays within the maximum size.', async(): Promise<void> => {
    const handleSafe = jest.spyOn(converter, 'handleSafe')
      .mockResolvedValue(new BasicRepresentation('transformedData', 'wrong/type'));
    validator = new RdfValidator(converter, 1024);
    const representation = new BasicRepresentation('a'.repeat(512), 'content/type');
    await expect(validator.handle({ representation, identifier })).resolves.toBeDefined();
    // Make sure the data can still be streamed
    await expect(readableToString(representation.data)).resolves.toBe('a'.repeat(512));
    expect(handleSafe).toHaveBeenCalledTimes(1);
  });

  it('rejects an oversized document before it is fully buffered.', async(): Promise<void> => {
    const handleSafe = jest.spyOn(converter, 'handleSafe');
    let emitted = 0;
    const source = guardStream(new Readable({
      read(): void {
        emitted += 1;
        // Would emit 1000 KiB in total if fully read
        this.push(emitted <= 1000 ? Buffer.alloc(1024, 0x61) : null);
      },
    }));
    const representation = new BasicRepresentation(source, 'content/type', true);
    validator = new RdfValidator(converter, 4096);
    await expect(validator.handle({ representation, identifier })).rejects.toThrow(PayloadHttpError);
    expect(handleSafe).not.toHaveBeenCalled();
    // Make sure the stream was aborted before being fully read
    expect(emitted).toBeLessThan(1000);
    expect(representation.data.destroyed).toBe(true);
  });

  it('does not limit the size when maxSize is 0.', async(): Promise<void> => {
    const handleSafe = jest.spyOn(converter, 'handleSafe')
      .mockResolvedValue(new BasicRepresentation('transformedData', 'wrong/type'));
    validator = new RdfValidator(converter, 0);
    const representation = new BasicRepresentation('a'.repeat(100000), 'content/type');
    await expect(validator.handle({ representation, identifier })).resolves.toBeDefined();
    expect(handleSafe).toHaveBeenCalledTimes(1);
  });
});
