import type { Readable } from 'node:stream';
import { PassThrough } from 'node:stream';
import type { ValidatorInput } from '../../../../src/http/auxiliary/Validator';
import { BasicRepresentation } from '../../../../src/http/representation/BasicRepresentation';
import { RepresentationMetadata } from '../../../../src/http/representation/RepresentationMetadata';
import type { ResourceIdentifier } from '../../../../src/http/representation/ResourceIdentifier';
import type { QuotaStrategy } from '../../../../src/storage/quota/QuotaStrategy';
import { UNIT_BYTES } from '../../../../src/storage/size-reporter/Size';
import type { SizeReporter } from '../../../../src/storage/size-reporter/SizeReporter';
import { QuotaValidator } from '../../../../src/storage/validators/QuotaValidator';
import { guardStream } from '../../../../src/util/GuardedStream';
import type { Guarded } from '../../../../src/util/GuardedStream';
import { guardedStreamFrom, readableToString } from '../../../../src/util/StreamUtil';

// Flushes pending micro- and macrotasks so a settled stream's reservation release has run.
async function flush(): Promise<void> {
  await new Promise<void>((resolve): void => {
    setImmediate(resolve);
  });
}

describe('QuotaValidator', (): void => {
  let mockedStrategy: jest.Mocked<QuotaStrategy>;
  let validator: QuotaValidator;
  let identifier: ResourceIdentifier;
  let mockMetadata: RepresentationMetadata;
  let mockData: Guarded<Readable>;
  let mockInput: ValidatorInput;
  let mockReporter: jest.Mocked<SizeReporter<any>>;

  beforeEach((): void => {
    jest.clearAllMocks();
    identifier = { path: 'http://localhost/' };
    mockMetadata = new RepresentationMetadata();
    mockData = guardedStreamFrom([ 'test string' ]);
    mockInput = {
      representation: new BasicRepresentation(mockData, mockMetadata),
      identifier,
    };
    mockReporter = {
      getSize: jest.fn(),
      getUnit: jest.fn(),
      calculateChunkSize: jest.fn(),
      estimateSize: jest.fn().mockResolvedValue(8),
    };
    mockedStrategy = {
      reporter: mockReporter,
      limit: { unit: UNIT_BYTES, amount: 8 },
      getAvailableSpace: jest.fn().mockResolvedValue({ unit: UNIT_BYTES, amount: 10 }),
      estimateSize: jest.fn().mockResolvedValue({ unit: UNIT_BYTES, amount: 8 }),
      getQuotaScope: jest.fn().mockResolvedValue('scope'),
      // Return a fresh guard for every call so a validator can handle multiple writes.
      createQuotaGuard: jest.fn(async(): Promise<Guarded<PassThrough>> => guardStream(new PassThrough())),
    } as any;
    validator = new QuotaValidator(mockedStrategy);
  });

  // Builds an input with a fresh, single-use data stream so `handle` can be called repeatedly.
  function freshInput(): ValidatorInput {
    return {
      representation: new BasicRepresentation(guardedStreamFrom([ 'test string' ]), new RepresentationMetadata()),
      identifier,
    };
  }

  describe('handle()', (): void => {
    // Step 2
    it('should destroy the stream when estimated size is larger than the available size.', async(): Promise<void> => {
      mockedStrategy.estimateSize.mockResolvedValueOnce({ unit: UNIT_BYTES, amount: 11 });

      const result = validator.handle(mockInput);
      await expect(result).resolves.toBeDefined();
      const awaitedResult = await result;

      const prom = new Promise<void>((resolve, reject): void => {
        awaitedResult.data.on('error', (): void => resolve());
        awaitedResult.data.on('end', (): void => reject(new Error('reject')));
      });

      // Consume the stream
      await expect(readableToString(awaitedResult.data))
        .rejects.toThrow('Quota exceeded: Advertised Content-Length is');
      await expect(prom).resolves.toBeUndefined();
    });

    // Step 3
    it('should destroy the stream when quota is exceeded during write.', async(): Promise<void> => {
      mockedStrategy.createQuotaGuard.mockResolvedValueOnce(guardStream(new PassThrough({
        async transform(this): Promise<void> {
          this.destroy(new Error('error'));
        },
      })));

      const result = validator.handle(mockInput);
      await expect(result).resolves.toBeDefined();
      const awaitedResult = await result;

      const prom = new Promise<void>((resolve, reject): void => {
        awaitedResult.data.on('error', (): void => resolve());
        awaitedResult.data.on('end', (): void => reject(new Error('reject')));
      });

      // Consume the stream
      await expect(readableToString(awaitedResult.data)).rejects.toThrow('error');
      expect(mockedStrategy.createQuotaGuard).toHaveBeenCalledTimes(1);
      await expect(prom).resolves.toBeUndefined();
    });

    // Step 4
    it('should throw when quota were exceeded after stream was finished.', async(): Promise<void> => {
      const result = validator.handle(mockInput);

      // Putting this after the handle / before consuming the stream will only effect
      // this function in the flush part of the code.
      mockedStrategy.getAvailableSpace.mockResolvedValueOnce({ unit: UNIT_BYTES, amount: -100 });

      await expect(result).resolves.toBeDefined();
      const awaitedResult = await result;

      const prom = new Promise<void>((resolve, reject): void => {
        awaitedResult.data.on('error', (): void => resolve());
        awaitedResult.data.on('end', (): void => reject(new Error('reject')));
      });

      // Consume the stream
      await expect(readableToString(awaitedResult.data)).rejects.toThrow('Quota exceeded after write completed');
      await expect(prom).resolves.toBeUndefined();
    });

    it('should return a stream that is consumable without error if quota isn\'t exceeded.', async(): Promise<void> => {
      const result = validator.handle(mockInput);
      await expect(result).resolves.toBeDefined();
      const awaitedResult = await result;
      await expect(readableToString(awaitedResult.data)).resolves.toBe('test string');
    });

    it('should reject a concurrent write when earlier writes reserved the space.', async(): Promise<void> => {
      mockedStrategy.estimateSize.mockResolvedValue({ unit: UNIT_BYTES, amount: 6 });

      // First write reserves 6 of the 10 available bytes but is left in-flight (not consumed).
      const first = await validator.handle(freshInput());
      expect(first.data).toBeDefined();

      // Second write only has 4 bytes left after the reservation, so its 6 bytes no longer fit.
      const second = await validator.handle(freshInput());
      await expect(readableToString(second.data))
        .rejects.toThrow('Quota exceeded: Advertised Content-Length is 6 bytes and only 4 bytes is available');
    });

    it('should release the reservation on finish so a following write succeeds.', async(): Promise<void> => {
      // With only 2 bytes to spare, a leaked 8-byte reservation would reject the second write.
      mockedStrategy.getAvailableSpace.mockResolvedValue({ unit: UNIT_BYTES, amount: 10 });

      const first = await validator.handle(freshInput());
      await expect(readableToString(first.data)).resolves.toBe('test string');
      await flush();

      const second = await validator.handle(freshInput());
      await expect(readableToString(second.data)).resolves.toBe('test string');
    });

    it('should release the reservation when the write is aborted so no space is leaked.', async(): Promise<void> => {
      const first = await validator.handle(freshInput());
      // Simulate a client abort by destroying the returned stream before it finishes.
      first.data.destroy();
      await flush();

      const second = await validator.handle(freshInput());
      await expect(readableToString(second.data)).resolves.toBe('test string');
    });

    it('should keep the reservations of other in-flight writes when one write settles.', async(): Promise<void> => {
      mockedStrategy.getAvailableSpace.mockResolvedValue({ unit: UNIT_BYTES, amount: 100 });
      mockedStrategy.estimateSize.mockResolvedValue({ unit: UNIT_BYTES, amount: 8 });

      // Two in-flight writes reserve 16 bytes in total.
      const first = await validator.handle(freshInput());
      const second = await validator.handle(freshInput());
      expect(second.data).toBeDefined();

      // Finishing the first write releases only its 8 bytes, leaving the second's 8 reserved.
      await readableToString(first.data);
      await flush();

      // A 93-byte write no longer fits (100 - 8 < 93), proving the remaining reservation was kept.
      mockedStrategy.estimateSize.mockResolvedValueOnce({ unit: UNIT_BYTES, amount: 93 });
      const third = await validator.handle(freshInput());
      await expect(readableToString(third.data)).rejects.toThrow('Quota exceeded');
    });

    it('should fall back to the streaming guard when the size is unknown.', async(): Promise<void> => {
      mockedStrategy.estimateSize.mockResolvedValue(undefined);

      const result = await validator.handle(freshInput());
      await expect(readableToString(result.data)).resolves.toBe('test string');
      // An unknown size cannot be reserved, so the scope is never even resolved.
      expect(mockedStrategy.getQuotaScope).not.toHaveBeenCalled();
    });

    it('should not reserve space for identifiers without a quota scope.', async(): Promise<void> => {
      mockedStrategy.getQuotaScope.mockResolvedValue('');

      // The write is allowed, and because nothing is reserved a following equal write still fits.
      const first = await validator.handle(freshInput());
      await expect(readableToString(first.data)).resolves.toBe('test string');

      const second = await validator.handle(freshInput());
      await expect(readableToString(second.data)).resolves.toBe('test string');
    });
  });
});
