import { Readable } from 'node:stream';
import type { Validator, ValidatorInput } from '../../../../src/http/auxiliary/Validator';
import { BasicRepresentation } from '../../../../src/http/representation/BasicRepresentation';
import type { Representation } from '../../../../src/http/representation/Representation';
import { RepresentationMetadata } from '../../../../src/http/representation/RepresentationMetadata';
import type { DataAccessor } from '../../../../src/storage/accessors/DataAccessor';
import { ValidatingDataAccessor } from '../../../../src/storage/accessors/ValidatingDataAccessor';
import { guardedStreamFrom } from '../../../../src/util/StreamUtil';

describe('ValidatingDataAccessor', (): void => {
  let validatingAccessor: ValidatingDataAccessor;
  let childAccessor: jest.Mocked<DataAccessor>;
  let validator: jest.Mocked<Validator>;

  const mockIdentifier = { path: 'http://localhost/test.txt' };
  const mockMetadata = new RepresentationMetadata();
  const mockData = guardedStreamFrom('test string');
  const mockRepresentation = new BasicRepresentation(mockData, mockMetadata);

  beforeEach(async(): Promise<void> => {
    jest.clearAllMocks();
    childAccessor = {
      getChildren: jest.fn(),
      writeDocument: jest.fn(),
      writeContainer: jest.fn(),
      writeMetadata: jest.fn(),
    } as any;
    validator = {
      handleSafe: jest.fn(async(input: ValidatorInput): Promise<Representation> => input.representation),
    } as any;
    validatingAccessor = new ValidatingDataAccessor(childAccessor, validator);
  });

  describe('writeDocument()', (): void => {
    it('should call the validator\'s handleSafe() function.', async(): Promise<void> => {
      await validatingAccessor.writeDocument(mockIdentifier, mockData, mockMetadata);
      expect(validator.handleSafe).toHaveBeenCalledTimes(1);
      expect(validator.handleSafe).toHaveBeenCalledWith({
        representation: mockRepresentation,
        identifier: mockIdentifier,
      });
    });

    it('should call the accessors writeDocument() function.', async(): Promise<void> => {
      await validatingAccessor.writeDocument(mockIdentifier, mockData, mockMetadata);
      expect(childAccessor.writeDocument).toHaveBeenCalledTimes(1);
      expect(childAccessor.writeDocument).toHaveBeenCalledWith(mockIdentifier, mockData, mockMetadata);
    });
  });

  describe('writeContainer()', (): void => {
    it('should call the accessors writeContainer() function.', async(): Promise<void> => {
      await validatingAccessor.writeContainer(mockIdentifier, mockMetadata);
      expect(childAccessor.writeContainer).toHaveBeenCalledTimes(1);
      expect(childAccessor.writeContainer).toHaveBeenCalledWith(mockIdentifier, mockMetadata);
    });
  });

  describe('writeMetadata()', (): void => {
    it('should validate the serialized metadata against the quota.', async(): Promise<void> => {
      await validatingAccessor.writeMetadata(mockIdentifier, mockMetadata);
      expect(validator.handleSafe).toHaveBeenCalledTimes(1);
      // The data stream is a freshly serialized copy of the metadata quads, so only assert the parts we control.
      expect(validator.handleSafe).toHaveBeenCalledWith(expect.objectContaining({
        identifier: mockIdentifier,
        representation: expect.objectContaining({ metadata: mockMetadata }),
      }));
    });

    it('should call the accessors writeMetadata() function when validation passes.', async(): Promise<void> => {
      await validatingAccessor.writeMetadata(mockIdentifier, mockMetadata);
      expect(childAccessor.writeMetadata).toHaveBeenCalledTimes(1);
      expect(childAccessor.writeMetadata).toHaveBeenCalledWith(mockIdentifier, mockMetadata);
    });

    it('should reject and not write the metadata when the quota is exceeded.', async(): Promise<void> => {
      validator.handleSafe.mockResolvedValueOnce(new BasicRepresentation(new Readable({
        read(this): void {
          this.destroy(new Error('Quota exceeded'));
        },
      }), mockMetadata));
      await expect(validatingAccessor.writeMetadata(mockIdentifier, mockMetadata)).rejects.toThrow('Quota exceeded');
      expect(childAccessor.writeMetadata).not.toHaveBeenCalled();
    });
  });
});
