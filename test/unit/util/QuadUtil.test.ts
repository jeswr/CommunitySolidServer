/* eslint-disable @typescript-eslint/no-deprecated -- These tests protect the compatibility API. */
import 'jest-rdf';
import type { Quad } from '@rdfjs/types';
import arrayifyStream from 'arrayify-stream';
import { DataFactory, Store } from 'n3';
import { parseQuads, serializeQuads, solveBgp, termToInt, uniqueQuads } from '../../../src/util/QuadUtil';
import { guardedStreamFrom, readableToString } from '../../../src/util/StreamUtil';
import variable = DataFactory.variable;

const { literal, namedNode, quad } = DataFactory;

describe('QuadUtil', (): void => {
  describe('#serializeQuads', (): void => {
    it('converts quads to the requested format.', async(): Promise<void> => {
      const quads = [ quad(
        namedNode('pre:sub'),
        namedNode('pre:pred'),
        literal('obj'),
      ) ];
      const stream = serializeQuads(quads, 'application/n-triples');
      await expect(readableToString(stream)).resolves.toMatch('<pre:sub> <pre:pred> "obj" .');
    });

    it('converts quads to turtle if no format was given.', async(): Promise<void> => {
      const quads = [ quad(
        namedNode('pre:sub'),
        namedNode('pre:pred'),
        literal('obj'),
      ) ];
      const stream = serializeQuads(quads);
      await expect(readableToString(stream)).resolves.toBe('<pre:sub> <pre:pred> "obj".\n');
    });

    it('returns a stream without data if there are no quads.', async(): Promise<void> => {
      const stream = serializeQuads([]);
      await expect(arrayifyStream(stream)).resolves.toEqual([]);
    });

    it('emits serialization errors through the resulting stream.', async(): Promise<void> => {
      const quads = [
        quad(namedNode('pre:sub'), namedNode('pre:pred'), literal('obj')),
        {} as unknown as Quad,
      ];
      const stream = serializeQuads(quads);
      const promise = readableToString(stream);
      await expect(promise).rejects.toThrow(TypeError);
      await expect(promise).rejects.toThrow('Cannot read properties of undefined (reading \'equals\')');
    });
  });

  describe('#parseQuads', (): void => {
    it('parses quads.', async(): Promise<void> => {
      const stream = guardedStreamFrom([ '<pre:sub> <pre:pred> "obj".' ]);
      await expect(parseQuads(stream)).resolves.toEqualRdfQuadArray([ quad(
        namedNode('pre:sub'),
        namedNode('pre:pred'),
        literal('obj'),
      ) ]);
    });

    it('parses quads with the given options.', async(): Promise<void> => {
      const stream = guardedStreamFrom([ '<> <pre:pred> "obj".' ]);
      await expect(parseQuads(stream, { baseIRI: 'pre:sub' })).resolves.toEqualRdfQuadArray([ quad(
        namedNode('pre:sub'),
        namedNode('pre:pred'),
        literal('obj'),
      ) ]);
    });

    it('parses quads with the given blank node prefix.', async(): Promise<void> => {
      const stream = guardedStreamFrom([ '_:a <pre:pred> "obj".' ]);
      const quads = await parseQuads(stream, { blankNodePrefix: 'pre' });
      expect(quads).toHaveLength(1);
      expect(quads[0].subject.value).toBe('prea');
    });

    it('parses buffers without corrupting multi-byte characters split across chunks.', async(): Promise<void> => {
      const buffer = Buffer.from('<pre:sub> <pre:pred> "héllo".');
      // Split in the middle of the 2-byte é character
      const index = buffer.indexOf(Buffer.from('é')) + 1;
      const stream = guardedStreamFrom([ buffer.subarray(0, index), buffer.subarray(index) ]);
      await expect(parseQuads(stream)).resolves.toEqualRdfQuadArray([ quad(
        namedNode('pre:sub'),
        namedNode('pre:pred'),
        literal('héllo'),
      ) ]);
    });

    it('parses a mix of string and buffer chunks.', async(): Promise<void> => {
      const stream = guardedStreamFrom([ '<pre:sub> <pre:pred> ', Buffer.from('"obj".') ]);
      await expect(parseQuads(stream)).resolves.toEqualRdfQuadArray([ quad(
        namedNode('pre:sub'),
        namedNode('pre:pred'),
        literal('obj'),
      ) ]);
    });

    it('resolves to an empty array if the stream contains no data.', async(): Promise<void> => {
      const stream = guardedStreamFrom([]);
      await expect(parseQuads(stream)).resolves.toEqual([]);
    });

    it('errors on invalid data.', async(): Promise<void> => {
      const stream = guardedStreamFrom([ 'this is not turtle' ]);
      const promise = parseQuads(stream);
      await expect(promise).rejects.toThrow(Error);
      await expect(promise).rejects.toThrow('Unexpected "this" on line 1.');
    });

    it('errors if the input stream errors.', async(): Promise<void> => {
      const stream = guardedStreamFrom([ '<pre:sub> <pre:pred> "obj".' ]);
      stream.destroy(new Error('source failure'));
      await expect(parseQuads(stream)).rejects.toThrow('source failure');
    });
  });

  describe('#uniqueQuads', (): void => {
    it('filters out duplicate quads.', async(): Promise<void> => {
      const quads = [
        quad(namedNode('ex:s1'), namedNode('ex:p1'), namedNode('ex:o1')),
        quad(namedNode('ex:s2'), namedNode('ex:p2'), namedNode('ex:o2')),
        quad(namedNode('ex:s1'), namedNode('ex:p1'), namedNode('ex:o1')),
      ];
      expect(uniqueQuads(quads)).toBeRdfIsomorphic([
        quad(namedNode('ex:s1'), namedNode('ex:p1'), namedNode('ex:o1')),
        quad(namedNode('ex:s2'), namedNode('ex:p2'), namedNode('ex:o2')),
      ]);
    });
  });

  describe('#termToInt', (): void => {
    it('returns undefined if the input is undefined.', async(): Promise<void> => {
      expect(termToInt()).toBeUndefined();
    });

    it('converts the term to a number.', async(): Promise<void> => {
      expect(termToInt(namedNode('5'))).toBe(5);
      expect(termToInt(namedNode('0xF'), 16)).toBe(15);
    });
  });

  describe('#solveBgp', (): void => {
    it('finds all matching bindings.', async(): Promise<void> => {
      const bgp = [
        quad(namedNode('ex:s1'), namedNode('ex:p1'), variable('v1')),
        quad(variable('v1'), namedNode('ex:p2'), variable('v2')),
        quad(variable('v1'), variable('v3'), variable('v2')),
      ];
      const data = new Store([
        quad(namedNode('ex:s1'), namedNode('ex:p1'), namedNode('ex:o1')),
        quad(namedNode('ex:o1'), namedNode('ex:p2'), namedNode('ex:o2')),
        quad(namedNode('ex:s1'), namedNode('ex:p1'), namedNode('ex:o2')),
        quad(namedNode('ex:o2'), namedNode('ex:p2'), namedNode('ex:o2')),
        quad(namedNode('ex:s1'), namedNode('ex:p1'), namedNode('ex:o3')),
        quad(namedNode('ex:o4'), namedNode('ex:p2'), namedNode('ex:o2')),
      ]);
      const bindings = solveBgp(bgp, data);
      expect(bindings).toHaveLength(2);
      expect(bindings[0]).toEqual({
        v1: namedNode('ex:o1'),
        v2: namedNode('ex:o2'),
        v3: namedNode('ex:p2'),
      });
      expect(bindings[1]).toEqual({
        v1: namedNode('ex:o2'),
        v2: namedNode('ex:o2'),
        v3: namedNode('ex:p2'),
      });
    });
  });
});
