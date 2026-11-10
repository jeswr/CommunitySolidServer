import 'jest-rdf';
import { DataFactory as DF } from 'n3';
import type { StorageLocationStrategy } from '../../../../src/server/description/StorageLocationStrategy';
import { LinksetMapper } from '../../../../src/storage/conversion/LinksetMapper';
import { SingleRootIdentifierStrategy } from '../../../../src/util/identifiers/SingleRootIdentifierStrategy';
import { IANA_RELATION_NAMESPACE } from '../../../../src/util/LinksetUtil';
import { DC, IANA, LDP, LWS, PIM, RDF, SOLID_META } from '../../../../src/util/Vocabularies';
import { SimpleSuffixStrategy } from '../../../util/SimpleSuffixStrategy';

describe('A LinksetMapper', (): void => {
  const root = 'http://test.com/';
  const subject = { path: 'http://test.com/foo/bar' };
  const linkset = { path: 'http://test.com/foo/bar.meta' };
  const metadataStrategy = new SimpleSuffixStrategy('.meta');
  const identifierStrategy = new SingleRootIdentifierStrategy(root);
  let storageStrategy: jest.Mocked<StorageLocationStrategy>;
  let mapper: LinksetMapper;

  beforeEach(async(): Promise<void> => {
    storageStrategy = {
      getStorageIdentifier: jest.fn().mockResolvedValue({ path: root }),
    };
    mapper = new LinksetMapper(metadataStrategy, identifierStrategy, storageStrategy);
  });

  it('returns the subject of a linkset.', async(): Promise<void> => {
    expect(mapper.getSubject(linkset)).toEqual(subject);
  });

  describe('toLinks', (): void => {
    it('converts the metadata of the subject to links.', async(): Promise<void> => {
      const quads = [
        DF.quad(DF.namedNode(subject.path), RDF.terms.type, LDP.terms.Resource),
        DF.quad(DF.namedNode(subject.path), DF.namedNode('http://example.com/rel'), DF.namedNode('http://example.com/a')),
        DF.quad(DF.namedNode(subject.path), DC.terms.modified, DF.literal('2024-01-01T00:00:00Z')),
        DF.quad(DF.namedNode(subject.path), DF.namedNode('urn:npm:solid:community-server:meta:x'), DF.namedNode(root)),
        DF.quad(DF.namedNode('http://test.com/other'), RDF.terms.type, LDP.terms.Resource),
      ];
      await expect(mapper.toLinks(linkset, quads)).resolves.toEqual([
        { anchor: subject.path, rel: 'type', href: LDP.Resource },
        { anchor: subject.path, rel: 'http://example.com/rel', href: 'http://example.com/a' },
        { anchor: subject.path, rel: 'up', href: 'http://test.com/foo/' },
        { anchor: subject.path, rel: 'type', href: LWS.DataResource },
      ]);
    });

    it('does not add a parent link for the root container.', async(): Promise<void> => {
      await expect(mapper.toLinks({ path: `${root}.meta` }, [])).resolves.toEqual([
        { anchor: root, rel: 'type', href: LWS.Container },
      ]);
      expect(storageStrategy.getStorageIdentifier).toHaveBeenCalledTimes(0);
    });

    it('does not add a parent link for storage roots.', async(): Promise<void> => {
      const pod = 'http://test.com/pod/';
      storageStrategy.getStorageIdentifier.mockResolvedValueOnce({ path: pod });
      await expect(mapper.toLinks({ path: `${pod}.meta` }, [])).resolves.toEqual([
        { anchor: pod, rel: 'type', href: LWS.Container },
      ]);
    });

    it('adds a parent link if the storage can not be determined.', async(): Promise<void> => {
      storageStrategy.getStorageIdentifier.mockRejectedValueOnce(new Error('bad data'));
      await expect(mapper.toLinks(linkset, [])).resolves.toEqual([
        { anchor: subject.path, rel: 'up', href: 'http://test.com/foo/' },
        { anchor: subject.path, rel: 'type', href: LWS.DataResource },
      ]);
    });

    it('only uses the identifier strategy if there is no storage strategy.', async(): Promise<void> => {
      mapper = new LinksetMapper(metadataStrategy, identifierStrategy);
      await expect(mapper.toLinks({ path: 'http://test.com/pod/.meta' }, [])).resolves.toEqual([
        { anchor: 'http://test.com/pod/', rel: 'up', href: root },
        { anchor: 'http://test.com/pod/', rel: 'type', href: LWS.Container },
      ]);
    });
  });

  describe('toQuads', (): void => {
    it('preserves server-managed metadata and replaces the other metadata with the links.', async(): Promise<void> => {
      const s = DF.namedNode(subject.path);
      const original = [
        DF.quad(DF.namedNode('http://test.com/other'), DF.namedNode('http://example.com/rel'), DF.namedNode(root)),
        DF.quad(DF.blankNode(), DF.namedNode('http://example.com/rel'), DF.namedNode(root)),
        DF.quad(s, DC.terms.modified, DF.literal('2024-01-01T00:00:00Z')),
        DF.quad(s, DF.namedNode('urn:npm:solid:community-server:meta:x'), DF.namedNode(root)),
        DF.quad(s, LDP.terms.contains, DF.namedNode(`${subject.path}/child`)),
        DF.quad(s, RDF.terms.type, LDP.terms.Resource),
        DF.quad(s, RDF.terms.type, PIM.terms.Storage),
        DF.quad(s, RDF.terms.type, DF.namedNode(`${IANA.namespace}text/turtle#Resource`)),
        DF.quad(s, RDF.terms.type, DF.namedNode('http://example.com/Old')),
        DF.quad(s, DF.namedNode('http://example.com/rel'), DF.namedNode('http://example.com/old')),
        DF.quad(s, SOLID_META.terms.ResponseMetadata, DF.namedNode(root), SOLID_META.terms.ResponseMetadata),
      ];
      const links = [
        { anchor: subject.path, rel: 'up', href: root },
        { anchor: subject.path, rel: 'linkset', href: linkset.path },
        { anchor: subject.path, rel: LWS.storage, href: root },
        { anchor: subject.path, rel: 'type', href: LWS.Container },
        { anchor: subject.path, rel: 'item', href: `${subject.path}/new` },
        { anchor: subject.path, rel: 'type', href: 'http://example.com/New' },
        { anchor: subject.path, rel: 'describedby', href: 'http://example.com/new' },
      ];
      expect(mapper.toQuads(linkset, links, original)).toEqualRdfQuadArray([
        original[0],
        original[1],
        original[2],
        original[3],
        original[4],
        original[5],
        original[6],
        original[7],
        original[10],
        DF.quad(s, RDF.terms.type, DF.namedNode('http://example.com/New')),
        DF.quad(s, DF.namedNode(`${IANA_RELATION_NAMESPACE}describedby`), DF.namedNode('http://example.com/new')),
      ]);
    });
  });
});
