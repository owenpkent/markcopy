import { describe, expect, it } from 'vitest';
import { buildZip, readZip } from './zipFixture';
import { encryptionRows, scanManifest } from '../../src/pkg/odf';

const NS = 'xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"';
const plain = (path: string, type = 'text/xml') =>
  `<manifest:file-entry manifest:full-path="${path}" manifest:media-type="${type}"/>`;
const locked = (
  path: string,
  algorithm = 'http://www.w3.org/2001/04/xmlenc#aes256-cbc',
  kdf = '<manifest:key-derivation manifest:key-derivation-name="PBKDF2" manifest:key-size="32" manifest:iteration-count="100000" manifest:salt="AAAA"/>',
) =>
  `<manifest:file-entry manifest:full-path="${path}" manifest:size="40">` +
  `<manifest:encryption-data manifest:checksum-type="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0#sha256-1k" manifest:checksum="AAAA">` +
  `<manifest:algorithm manifest:algorithm-name="${algorithm}" manifest:initialisation-vector="AAAA"/>` +
  `${kdf}</manifest:encryption-data></manifest:file-entry>`;
const manifest = (...entries: string[]) =>
  `<?xml version="1.0"?><manifest:manifest ${NS} manifest:version="1.3">` +
  `${plain('/', 'application/vnd.oasis.opendocument.text')}${entries.join('')}</manifest:manifest>`;

const odf = (mime: string, manifestXml?: string) =>
  buildZip([
    { name: 'mimetype', data: mime },
    { name: 'content.xml', data: '<x/>' },
    ...(manifestXml ? [{ name: 'META-INF/manifest.xml', data: manifestXml }] : []),
  ]);

describe('OpenDocument files', () => {
  it('recognises the kind from the mimetype entry', async () => {
    const kinds: Array<[string, string]> = [
      ['text', 'OpenDocument text'],
      ['spreadsheet', 'OpenDocument spreadsheet'],
      ['presentation-template', 'OpenDocument presentation template'],
      ['graphics', 'OpenDocument drawing'],
    ];
    for (const [kind, format] of kinds) {
      const info = await readZip(odf(`application/vnd.oasis.opendocument.${kind}`));
      expect(info.format).toBe(format);
      expect(info.fileRows).toBeUndefined();
    }
  });

  it('is not recognised without the mimetype entry', async () => {
    const info = await readZip(buildZip([{ name: 'a.txt', data: 'hi' }]));
    expect(info.format).toBe('Zip archive');
  });

  it('labels AES-256-CBC with PBKDF2 and counts the encrypted entries', async () => {
    const xml = manifest(plain('mimetype'), locked('content.xml'), locked('styles.xml'));
    const info = await readZip(odf('application/vnd.oasis.opendocument.text', xml));
    expect(info.fileRows).toEqual([
      ['Encryption', '2 of 3 entries: AES-256-CBC'],
      ['Key derivation', 'PBKDF2 (100,000 iterations)'],
    ]);
  });

  it('labels AES-256-GCM with Argon2id parameters', () => {
    const kdf =
      '<manifest:key-derivation manifest:key-derivation-name="urn:org:documentfoundation:names:experimental:office:manifest:argon2id" loext:argon2-iterations="3" loext:argon2-memory="65536" loext:argon2-lanes="4"/>';
    const out = scanManifest(
      manifest(
        locked('content.xml', 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0:aes256-gcm', kdf),
      ),
    );
    expect(out.algorithms).toEqual(['AES-256-GCM']);
    expect(out.derivations).toEqual(['Argon2id (3 iterations, 65,536 KiB memory, 4 lanes)']);
  });

  it('names Blowfish CFB as legacy', () => {
    const out = scanManifest(manifest(locked('content.xml', 'Blowfish CFB')));
    expect(out.algorithms).toEqual(['Blowfish CFB (legacy)']);
  });

  it('reports a manifest with no encryption as nothing', async () => {
    const xml = manifest(plain('content.xml'));
    const info = await readZip(odf('application/vnd.oasis.opendocument.spreadsheet', xml));
    expect(info.fileRows).toBeUndefined();
  });

  it('tolerates a manifest cut short and says the entries were the ones read', async () => {
    const full = manifest(locked('content.xml'), locked('styles.xml'));
    const cut = full.slice(0, full.indexOf('</manifest:file-entry>') + 22 + 45);
    const info = await readZip(odf('application/vnd.oasis.opendocument.text', cut));
    expect(info.fileRows?.[0]).toEqual(['Encryption', '1 of the 1 entry read: AES-256-CBC']);
    const garbage = await readZip(odf('application/vnd.oasis.opendocument.text', '<<<<'));
    expect(garbage.format).toBe('OpenDocument text');
    expect(garbage.fileRows).toBeUndefined();
  });

  it('says the cipher was not determined when the algorithm is missing', () => {
    const xml = manifest(
      '<manifest:file-entry manifest:full-path="content.xml"><manifest:encryption-data/></manifest:file-entry>',
    );
    expect(scanManifest(xml).algorithms).toEqual(['cipher not determined']);
  });

  it('does not take a comment after a self-closing entry for its child', () => {
    const xml = manifest(
      plain('content.xml'),
      '<!-- The preceding file has no <manifest:encryption-data> child. -->',
    );
    const out = scanManifest(xml);
    expect(out.total).toBe(1);
    expect(out.encrypted).toBe(0);
    expect(encryptionRows(out)).toBeUndefined();
  });

  it('skips long quoted values in linear time and still reads the entries around them', () => {
    const long = 'a'.repeat(20_000);
    const xml = manifest(...Array.from({ length: 8 }, () => plain(long)), locked('content.xml'));
    const started = performance.now();
    const out = scanManifest(xml);
    expect(performance.now() - started).toBeLessThan(1000);
    // The long paths are dropped as attributes, so only the readable entry counts.
    expect(out.total).toBe(1);
    expect(out.encrypted).toBe(1);
    expect(out.algorithms).toEqual(['AES-256-CBC']);
  });

  it('keeps a generic zip whose mimetype member cannot be read as a zip', async () => {
    const info = await readZip(
      buildZip([
        { name: 'mimetype', data: 'x', methodNumber: 12 },
        { name: 'readme.txt', data: 'hello' },
      ]),
    );
    expect(info.format).toBe('Zip archive');
  });

  it('treats an inherited property name as an unknown kind', async () => {
    for (const kind of ['constructor', '__proto__', 'toString']) {
      const info = await readZip(odf(`application/vnd.oasis.opendocument.${kind}`));
      expect(info.format).toBe('OpenDocument file');
    }
  });
});
