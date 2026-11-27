import { describe, expect, it } from 'vitest';
import { bytesSource, formatBytes, ICON_MEDIA_ID, readPe, renderPeHtml } from '../../src/pe';
import {
  buildPe,
  buildRichStub,
  buildSignedData,
  iconBitmap,
  pngStub,
  tlv,
  type PeSpec,
} from './fixture';
import { inlineBlock, SAMPLE_LINES } from '../binary/goFixture';

// A PKCS #7 SignedData with the given signerInfos and no certificates, built
// here because the fixture's own always has exactly one signer and its
// certificate.
const SIGNED_DATA_OID = tlv(
  0x06,
  Uint8Array.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02]),
);
const ALGORITHM = tlv(0x30, tlv(0x06, Uint8Array.from([0x2a, 0x03, 0x04])));
/** A SignerInfo. `value` is its signature; pass `null` to leave the field out. */
const signerInfo = (value: Uint8Array | null = Uint8Array.of(1, 2, 3, 4)): Uint8Array =>
  tlv(
    0x30,
    tlv(0x02, Uint8Array.of(1)), // version
    tlv(0x30, tlv(0x30), tlv(0x02, Uint8Array.of(5))), // issuer and serial number
    ALGORITHM, // digestAlgorithm
    ALGORITHM, // digestEncryptionAlgorithm
    ...(value === null ? [] : [tlv(0x04, value)]), // encryptedDigest
  );
const signedDataWith = (signers: Uint8Array[]): Uint8Array =>
  tlv(
    0x30,
    SIGNED_DATA_OID,
    tlv(
      0xa0,
      tlv(
        0x30,
        tlv(0x02, Uint8Array.of(1)), // version
        tlv(0x31), // digestAlgorithms
        tlv(0x30), // contentInfo
        tlv(0x31, ...signers), // signerInfos
      ),
    ),
  );

const RLO = String.fromCharCode(0x202e);
const BEL = String.fromCharCode(7);

async function render(spec: PeSpec = {}, fileName = 'tool.exe'): Promise<string> {
  const info = await readPe(bytesSource(buildPe(spec)));
  return renderPeHtml(info, { fileName });
}

describe('renderPeHtml: escaping and cleaning', () => {
  it('escapes markup in a version string', async () => {
    const html = await render({
      version: {
        fileVersion: [1, 0, 0, 0],
        strings: [['FileDescription', '<img src=x onerror=1>']],
      },
    });
    expect(html).toContain('&lt;img src=x onerror=1&gt;');
    expect(html).not.toContain('<img');
  });

  it('escapes markup in the file name, an export name, a library and a PDB path', async () => {
    const html = await render(
      {
        imports: [{ library: '<b>lib</b>.dll', functions: 1 }],
        exports: { dllName: '<i>x</i>.dll', names: ['<script>a()</script>'] },
        debug: { guid: '11223344-5566-7788-99AA-BBCCDDEEFF00', age: 1, pdbPath: '<u>p</u>.pdb' },
      },
      '<svg onload=1>.exe',
    );
    for (const tag of ['<svg', '<b>', '<i>', '<script', '<u>']) {
      expect(html).not.toContain(tag);
    }
    expect(html).toContain('&lt;svg onload=1&gt;.exe');
    expect(html).toContain('&lt;script&gt;a()&lt;/script&gt;');
  });

  it('strips direction overrides and control characters from strings drawn from the file', async () => {
    const html = await render({
      version: {
        fileVersion: [1, 0, 0, 0],
        strings: [['FileDescription', `evil${RLO}fdp.exe${BEL}`]],
      },
      exports: { dllName: `lib${RLO}.dll`, names: [`fn${RLO}${BEL}x`] },
      debug: { guid: '11223344-5566-7788-99AA-BBCCDDEEFF00', age: 1, pdbPath: `a${RLO}b.pdb` },
      certificate: buildSignedData({
        subject: { commonName: `Name${RLO}Z` },
        issuer: { commonName: 'CA' },
      }),
    });
    expect(html).not.toContain(RLO);
    expect(html).not.toContain(BEL);
    expect(html).toContain('evilfdp.exe');
    expect(html).toContain('NameZ');
    expect(html).toContain('ab.pdb');
  });

  it('strips direction overrides and control characters from the file name', async () => {
    const info = await readPe(bytesSource(buildPe()));
    const html = renderPeHtml(info, { fileName: `invoice${RLO}fdp.exe${BEL}` });
    expect(html).not.toContain(RLO);
    expect(html).not.toContain(BEL);
    expect(html).toContain('<h1>invoicefdp.exe</h1>');
  });
});

describe('renderPeHtml: content', () => {
  it('shows Any CPU for an IL-only x86 assembly', async () => {
    const html = await render({ clr: { runtime: 'v4.0.30319', flags: 0x1 } });
    expect(html).toContain('Any CPU (.NET)');
    expect(html).not.toContain('x86 (32-bit)');
    expect(html).toContain('runtime v4.0.30319');
  });

  it('says when an Any CPU assembly prefers 32-bit', async () => {
    const html = await render({ clr: { runtime: 'v4.0.30319', flags: 0x1 | 0x20000 } });
    expect(html).toContain('Any CPU (.NET, 32-bit preferred)');
  });

  it('keeps x86 for an assembly that requires 32-bit or is not IL-only', async () => {
    expect(await render({ clr: { runtime: 'v4.0.30319', flags: 0x1 | 0x2 } })).toContain(
      'x86 (32-bit)',
    );
    expect(await render({ clr: { runtime: 'v4.0.30319', flags: 0 } })).toContain('x86 (32-bit)');
    expect(await render({ plus: true, clr: { runtime: 'v4.0.30319', flags: 1 } })).toContain(
      'x64 (64-bit)',
    );
  });

  it('shows a reproducible build as not recorded, and a normal one as a UTC date', async () => {
    expect(await render({ repro: true })).toContain('Not recorded (reproducible build)');
    expect(await render({ timestamp: 1700000000 })).toContain('2023-11-14 22:13:20 UTC');
    expect(await render({ timestamp: 0 })).toContain('Not recorded');
  });

  it('says the signature is not verified, and shows the signer as a claim', async () => {
    const html = await render({
      certificate: buildSignedData({
        subject: { commonName: 'Contoso Software', organization: 'Contoso Ltd' },
        issuer: { commonName: 'Contoso CA' },
        notBefore: '230615000000Z',
        notAfter: '260615235959Z',
      }),
    });
    expect(html).toContain('not verified by MarkCopy');
    expect(html).toContain('MarkCopy does not check the signature');
    expect(html).toContain('Contoso Software');
    expect(html).toContain('Contoso Ltd');
    expect(html).toContain('Contoso CA');
    expect(html).toContain('2023-06-15 to 2026-06-15');
  });

  it('says the signature is not verified even when the signer cannot be read', async () => {
    // SignedData with one signer and no certificate for it: something signed,
    // and there is no certificate to take a name from.
    const html = await render({ certificate: signedDataWith([signerInfo()]) });
    expect(html).toContain('Embedded signature present, not verified by MarkCopy');
    expect(html).not.toContain('Signer</td>');
  });

  // SignedData with no signer is how a bundle of certificates is shipped. It
  // signs nothing, and was once reported as a signature because the entry was
  // SignedData at all.
  // A signer has to be one. An empty SEQUENCE in the signers set, or a
  // SignerInfo with no signature value in it, signed nothing.
  it('does not claim a signature for a signer that carries no signature value', async () => {
    const claims = async (signers: Uint8Array[]): Promise<boolean> =>
      (await render({ certificate: signedDataWith(signers) })).includes(
        'Embedded signature present',
      );
    expect(await claims([tlv(0x30)])).toBe(false);
    expect(await claims([tlv(0x30), tlv(0x30), tlv(0x30)])).toBe(false);
    expect(await claims([signerInfo(null)])).toBe(false);
    expect(await claims([signerInfo(new Uint8Array(0))])).toBe(false);
    // Something that is not a SEQUENCE at all, and a SEQUENCE of the wrong things.
    expect(await claims([tlv(0x04, Uint8Array.of(1, 2, 3))])).toBe(false);
    expect(
      await claims([tlv(0x30, tlv(0x04, Uint8Array.of(1)), tlv(0x04, Uint8Array.of(2)))]),
    ).toBe(false);
    // One real signer among empty ones is still a signature.
    expect(await claims([tlv(0x30), signerInfo()])).toBe(true);
    expect(await claims([signerInfo()])).toBe(true);
  });

  it('accepts a signer with authenticated attributes, and one named by key identifier', async () => {
    const withAttributes = tlv(
      0x30,
      tlv(0x02, Uint8Array.of(1)),
      tlv(0x30, tlv(0x30), tlv(0x02, Uint8Array.of(5))),
      ALGORITHM,
      tlv(0xa0, tlv(0x30)), // authenticatedAttributes
      ALGORITHM,
      tlv(0x04, Uint8Array.of(9, 9)),
      tlv(0xa1, tlv(0x30)), // unauthenticatedAttributes
    );
    const byKeyIdentifier = tlv(
      0x30,
      tlv(0x02, Uint8Array.of(3)),
      tlv(0x80, Uint8Array.of(1, 2, 3, 4)),
      ALGORITHM,
      ALGORITHM,
      tlv(0x04, Uint8Array.of(9)),
    );
    for (const signer of [withAttributes, byKeyIdentifier]) {
      const html = await render({ certificate: signedDataWith([signer]) });
      expect(html).toContain('Embedded signature present, not verified by MarkCopy');
    }
  });

  it('does not claim a signature for SignedData that has no signer', async () => {
    const html = await render({ certificate: signedDataWith([]) });
    expect(html).toContain('Certificate data present, with no Authenticode signature recognized');
    expect(html).not.toContain('Embedded signature present');
    const bare = Uint8Array.from([
      0x30, 0x0f, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02, 0xa0, 0x02,
      0x30, 0x00,
    ]);
    expect(await render({ certificate: bare })).not.toContain('Embedded signature present');
  });

  // A certificate table is not a signature. Bytes filed as PKCS #7 that are
  // not SignedData, or a bare certificate, sign nothing.
  it('does not claim a signature for certificate data that is not one', async () => {
    const html = await render({ certificate: new Uint8Array(40).fill(0x41) });
    expect(html).toContain('Certificate data present, with no Authenticode signature recognized');
    expect(html).not.toContain('Embedded signature present');
    expect(html).not.toContain('Signer</td>');
  });

  it('explains the catalog case when no signature is embedded', async () => {
    const html = await render();
    expect(html).toContain('No signature is embedded in this file');
    expect(html).toContain('catalog');
    expect(html).not.toContain('not verified by MarkCopy');
  });

  it('omits High-entropy ASLR for PE32 and shows it for PE32+', async () => {
    const narrow = await render({ dllCharacteristics: 0x60 });
    expect(narrow).not.toContain('High-entropy ASLR');
    expect(narrow).toContain('Large address aware');
    const wide = await render({ plus: true, dllCharacteristics: 0x60 });
    expect(wide).toContain('High-entropy ASLR');
    expect(wide).not.toContain('Large address aware');
  });

  it('shows the hash, or the reason there is none', async () => {
    const info = await readPe(bytesSource(buildPe()));
    expect(renderPeHtml(info, { fileName: 'a.exe', sha256: 'ab'.repeat(32) })).toContain(
      'ab'.repeat(32),
    );
    const noted = renderPeHtml(info, { fileName: 'a.exe', hashNote: 'Not computed for big files' });
    expect(noted).toContain('Not computed for big files');
    expect(renderPeHtml(info, { fileName: 'a.exe' })).not.toContain('SHA-256');
  });

  it('lists imports with when they load, and notes a truncated export list', async () => {
    const names = Array.from({ length: 120 }, (_, i) => `Fn${String(i).padStart(3, '0')}`);
    const html = await render({
      imports: [{ library: 'KERNEL32.dll', functions: 4 }],
      delayImports: [{ library: 'ole32.dll', functions: 1 }],
      exports: { dllName: 'x.dll', names },
    });
    expect(html).toContain('2 libraries.');
    expect(html).toContain('<td>4 functions</td>');
    expect(html).toContain('<td>1 function, loaded on first use</td>');
    expect(html).toContain('Showing the first 100 of 120 names.');
  });

  it('shows a warning for a table that could not be read, and the sentence for no version', async () => {
    const html = await render({ directories: { 1: { address: 0x7fff0000, size: 40 } } });
    expect(html).toContain('The import table could not be read.');
    expect(html).toContain('This file carries no version information.');
  });

  it('shows the manifest rows with a plain-language execution level', async () => {
    const html = await render({
      manifest:
        '<assembly><requestedExecutionLevel level="requireAdministrator" uiAccess="false"/></assembly>',
    });
    expect(html).toContain('requireAdministrator (asks for administrator rights)');
  });
});

describe('formatBytes', () => {
  it('writes small counts exactly, with the right singular', () => {
    expect(formatBytes(0)).toBe('0 bytes');
    expect(formatBytes(1)).toBe('1 byte');
    expect(formatBytes(1023)).toBe('1,023 bytes');
  });

  it('scales to KB, MB, GB and TB with the exact count beside it', () => {
    expect(formatBytes(1024)).toBe('1.00 KB (1,024 bytes)');
    expect(formatBytes(1536)).toBe('1.50 KB (1,536 bytes)');
    expect(formatBytes(10 * 1024)).toBe('10.0 KB (10,240 bytes)');
    expect(formatBytes(1024 * 1024)).toBe('1.00 MB (1,048,576 bytes)');
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.00 GB (5,368,709,120 bytes)');
    expect(formatBytes(1024 ** 4)).toBe('1.00 TB (1,099,511,627,776 bytes)');
  });
});

describe('renderPeHtml: icon', () => {
  const bitmapIcon = (width: number, height: number) => ({
    id: 1,
    width,
    height,
    bitCount: 32,
    data: iconBitmap({
      width,
      height,
      bitCount: 32,
      rgba: Array.from({ length: width * height }, () => [1, 2, 3, 255]),
    }),
  });

  it('starts the page with an image that the media message fills in', async () => {
    const html = await render({ icons: [bitmapIcon(16, 16)] });
    expect(html).toContain(
      '<p class="mc-exe-icon"><img data-mc-media="m1" alt="File icon" width="16" height="16"></p>',
    );
    expect(html.indexOf('mc-exe-icon')).toBeLessThan(html.indexOf('<h1>'));
    expect(html).not.toContain(' src=');
    expect(ICON_MEDIA_ID).toBe('m1');
  });

  it('draws a 256 pixel icon at 48 pixels', async () => {
    const icon = { id: 1, width: 256, height: 256, bitCount: 32, data: pngStub(256, 256) };
    expect(await render({ icons: [icon] })).toContain('width="48" height="48"');
  });

  it('keeps the aspect ratio of an icon that is not square', async () => {
    const html = await render({ icons: [bitmapIcon(64, 32)] });
    expect(html).toContain('width="48" height="24"');
  });

  it('draws a small icon at its natural size, never enlarged', async () => {
    expect(await render({ icons: [bitmapIcon(32, 32)] })).toContain('width="32" height="32"');
  });

  it('has no image when the file has no icon', async () => {
    const html = await render();
    expect(html).not.toContain('<img');
    expect(html).not.toContain('mc-exe-icon');
  });
});

// The page lays its sections out in two columns (media/preview.css), which
// needs each one wrapped, and the grids that need the full width marked.
describe('renderPeHtml: sections for the two-column layout', () => {
  it('wraps each section, and marks the wide grids', async () => {
    const info = await readPe(
      bytesSource(
        buildPe({
          dll: true,
          imports: [{ library: 'KERNEL32.dll', functions: 2 }],
          exports: { dllName: 'x.dll', names: ['A'] },
        }),
      ),
    );
    const html = renderPeHtml(info, { fileName: 'x.dll' });
    expect(html).toContain('<div class="mc-info-section"><h2>Version</h2>');
    expect(html).toContain('<div class="mc-info-section"><h2>File</h2>');
    expect(html).toContain('<div class="mc-info-section mc-info-wide"><h2>Sections</h2>');
    expect(html).toContain('<div class="mc-info-section mc-info-wide"><h2>Imports</h2>');
    expect(html).toContain('<div class="mc-info-section mc-info-wide"><h2>Exports</h2>');
    // Every heading sits inside a section: none is left loose between them.
    expect(html.match(/<h2>/g)).toHaveLength(html.match(/class="mc-info-section/g)?.length ?? 0);
  });
});

// The reader allows 1,024 libraries and as many again delay-loaded. Drawn in
// full, with long names, that was a 3 MB page from a file under 1 MB.
describe('renderPeHtml: caps the import rows it draws', () => {
  const many = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ library: `lib${i}.dll`, functions: 1 }));

  it('says a library’s functions were not counted rather than showing zero', async () => {
    const info = await readPe(
      bytesSource(buildPe({ delayImports: [{ library: 'WINHTTP.dll', functions: 2 }] })),
    );
    info.imports[0].functions = undefined;
    const html = renderPeHtml(info, { fileName: 'tool.exe' });
    expect(html).toContain('Not counted: the function list could not be read, loaded on first use');
    expect(html).not.toContain('0 functions');
  });

  it('draws every library of an ordinary program, with no note', async () => {
    const html = await render({ imports: many(40) });
    expect(html).toContain('<td>lib39.dll</td>');
    expect(html).not.toContain('Showing the first');
  });

  it('draws the first 500 of more, says how many there are, and stays small', async () => {
    const html = await render({ plus: true, imports: many(700) });
    expect(html).toContain('<td>lib499.dll</td>');
    expect(html).not.toContain('<td>lib500.dll</td>');
    expect(html).toContain('Showing the first 500 of 700 libraries.');
    expect(html).toContain('700 libraries.');
    expect(html.length).toBeLessThan(256 * 1024);
  });

  it('cuts a name no linker would write', async () => {
    const html = await render({ imports: [{ library: `${'&'.repeat(250)}.dll`, functions: 1 }] });
    expect(html).toContain('&amp;'.repeat(250));
    const long = await render({
      exports: { dllName: 'x.dll', names: ['n'.repeat(400)] },
    });
    expect(long).toContain(`<td>${'n'.repeat(256)}</td>`);
    expect(long).not.toContain('n'.repeat(257));
  });
});

// NX_COMPAT is a header flag. Whether DEP is in force is not the flag's to
// say: 64-bit Windows enforces it for every native 64-bit program regardless,
// so "DEP: No" on such a file misdescribed it.
describe('renderPeHtml: the DEP row says what the flag is, not what Windows does', () => {
  const dep = (html: string): string =>
    /<td>DEP compatible \(NX_COMPAT\)<\/td><td>([^<]*)<\/td>/.exec(html)?.[1] ?? 'missing';

  it('never says a native 64-bit program has no DEP', async () => {
    // ASLR set, NX_COMPAT clear.
    const html = await render({ plus: true, dllCharacteristics: 0x40 });
    expect(dep(html)).toBe('Flag not set (64-bit Windows enforces DEP regardless)');
    expect(html).not.toContain('Data execution prevention');
    expect(dep(await render({ plus: true, machine: 0xaa64, dllCharacteristics: 0x40 }))).toContain(
      'enforces DEP regardless',
    );
  });

  it('says Yes when the flag is set, on either width', async () => {
    expect(dep(await render({ plus: true, dllCharacteristics: 0x140 }))).toBe('Yes');
    expect(dep(await render({ dllCharacteristics: 0x140 }))).toBe('Yes');
  });

  it('says No for a 32-bit program without the flag, where the flag does decide', async () => {
    expect(dep(await render({ dllCharacteristics: 0x40 }))).toBe('No');
  });
});

describe('renderPeHtml: Go build information', () => {
  it('draws the program, its build settings and its modules after the protections', async () => {
    const html = await render({ plus: true, data: inlineBlock({ info: SAMPLE_LINES }) });
    const at = (heading: string): number => html.indexOf(`<h2>${heading}</h2>`);
    expect(at('Permissions and protections')).toBeGreaterThan(-1);
    expect(at('Go')).toBeGreaterThan(at('Permissions and protections'));
    expect(at('Go build settings')).toBeGreaterThan(at('Go'));
    expect(at('Go modules')).toBeGreaterThan(at('Go build settings'));
    expect(html).toContain('<td>Go version</td><td>go1.22.1</td>');
    expect(html).toContain('<td>Package</td><td>example.com/app/cmd/app</td>');
    expect(html).toContain('<td>Module version</td><td>v1.4.0</td>');
    expect(html).toContain('<td>-trimpath</td><td>true</td>');
    expect(html).toContain(
      '<td>golang.org/x/sys</td><td>v0.15.0, replaced by example.com/fork-sys v0.15.1</td>',
    );
    expect(html).not.toContain('Showing the first');
  });

  it('draws nothing for a file that is not a Go program', async () => {
    expect(await render({ plus: true })).not.toContain('<h2>Go');
  });

  it('lists 200 modules of the 700 it was given and says so', async () => {
    const lines = Array.from({ length: 700 }, (_, i) => `dep\tx.org/m${i}\tv1.0.${i}`);
    const html = await render({ data: inlineBlock({ info: lines }) });
    expect(html.match(/<td>x\.org\/m\d+<\/td>/g)).toHaveLength(200);
    expect(html).toContain('Showing the first 200 of 700 modules.');
  });

  it('escapes markup and removes direction overrides', async () => {
    const html = await render({
      data: inlineBlock({
        info: [
          `path\t<script>alert(1)</script>${RLO}x`,
          'dep\t<img src=x onerror=1>\tv1',
          `build\tk${RLO}=<b>`,
        ],
      }),
    });
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;x');
    expect(html).toContain('&lt;img src=x onerror=1&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>');
    expect(html).not.toContain(RLO);
  });

  it('shows the note about a damaged block at the top', async () => {
    const html = await render({ data: inlineBlock({ pointerSize: 7 }) });
    expect(html).toContain('The Go build information could not be read.');
    expect(html).not.toContain('<h2>Go</h2>');
  });
});

describe('Build tools and loader flags', () => {
  const html = async (spec: PeSpec, patch = (b: Uint8Array) => b) =>
    renderPeHtml(await readPe(bytesSource(patch(buildPe(spec)))), { fileName: 'a.exe' });
  const entries = [
    { productId: 0x0102, build: 33808, count: 1234 },
    { productId: 0x0105, build: 29913, count: 7 },
  ];

  it('shows a Build tools block with a row for each entry, after Debug information', async () => {
    const page = await html({
      dosStub: buildRichStub({ entries }),
      debug: { guid: '11111111-2222-3333-4444-555555555555', age: 1, pdbPath: 'a.pdb' },
    });
    expect(page).toContain('<h2>Build tools</h2>');
    expect(page).toContain("Recorded by Microsoft's linker.");
    expect(page).toContain('<th>Tool</th><th>Toolset</th><th>Build</th><th>Objects</th>');
    expect(page).toContain(
      '<td>Linker</td><td>Visual Studio 2022 or later</td><td>33808</td><td>1,234</td>',
    );
    expect(page).toContain(
      '<td>C++ compiler</td><td>Visual Studio 2019</td><td>29913</td><td>7</td>',
    );
    expect(page).not.toContain('Its checksum does not match');
    expect(page.indexOf('Debug information')).toBeLessThan(page.indexOf('Build tools'));
    expect(page.indexOf('Build tools')).toBeLessThan(page.indexOf('<h2>Sections</h2>'));
  });

  it('says so when the checksum does not match', async () => {
    const page = await html({ dosStub: buildRichStub({ entries }) }, (bytes) => {
      bytes[0x50] ^= 0xff;
      return bytes;
    });
    expect(page).toContain(
      '<p class="mc-exe-note">Its checksum does not match the header it covers',
    );
    expect(page).toContain('<td>Linker</td>');
  });

  it('draws no Build tools block without a record', async () => {
    expect(await html({})).not.toContain('Build tools');
  });

  it('shows Other loader flags only when one is set', async () => {
    expect(await html({ dllCharacteristics: 0x140 })).not.toContain('Other loader flags');
    const page = await html({ dllCharacteristics: 0x8540 });
    expect(page).toContain('Other loader flags');
    expect(page).toContain(
      'No structured exception handlers (NO_SEH), Terminal Server aware (TERMINAL_SERVER_AWARE)',
    );
  });
});

describe('renderPeHtml: Control Flow Guard and the other hardening rows', () => {
  const row = (html: string, label: string): string | undefined =>
    new RegExp(`<td>${label.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}</td><td>([^<]*)</td>`).exec(
      html,
    )?.[1];
  const cfg = async (spec: PeSpec): Promise<string | undefined> =>
    row(await render(spec), 'Control Flow Guard');
  const CF = 0x4000;
  const base = 0x140;

  it('says Yes, with a count, when the header bit and the guard data agree', async () => {
    const loadConfig = { guardFlags: 0x100, cfCount: 1234n };
    expect(await cfg({ dllCharacteristics: base | CF, loadConfig })).toBe(
      'Yes, 1,234 CFG target-table entries',
    );
    expect(await cfg({ plus: true, dllCharacteristics: base | CF, loadConfig })).toBe(
      'Yes, 1,234 CFG target-table entries',
    );
    expect(await cfg({ dllCharacteristics: base | CF, loadConfig: { guardFlags: 0x100 } })).toBe(
      'Yes',
    );
  });

  it('says the flag is set but there is no guard data', async () => {
    const none = 'Flag set, but the image has no guard data';
    expect(await cfg({ dllCharacteristics: base | CF })).toBe(none);
    expect(await cfg({ dllCharacteristics: base | CF, loadConfig: { guardFlags: 0 } })).toBe(none);
    // The structure ends before GuardFlags, so nothing can be said of the table.
    expect(
      await cfg({ dllCharacteristics: base | CF, loadConfig: { size: 0x58, guardFlags: 0x100 } }),
    ).toBe(none);
  });

  it('says compiled for it but not turned on, and No', async () => {
    expect(await cfg({ dllCharacteristics: base, loadConfig: { guardFlags: 0x100 } })).toBe(
      'Compiled for it, but not turned on',
    );
    expect(await cfg({ dllCharacteristics: base })).toBe('No');
  });

  it('shows stack cookies only when the structure holds the field', async () => {
    const label = 'Stack cookies (/GS)';
    expect(row(await render({}), label)).toBeUndefined();
    expect(row(await render({ loadConfig: { cookie: 1n } }), label)).toBe('Yes');
    expect(row(await render({ plus: true, loadConfig: { cookie: 1n } }), label)).toBe('Yes');
    expect(row(await render({ loadConfig: {} }), label)).toBe('No');
    expect(row(await render({ loadConfig: { cookie: 1n, guardFlags: 0x800 } }), label)).toBe('No');
    expect(row(await render({ loadConfig: { size: 0x3c, cookie: 1n } }), label)).toBeUndefined();
  });

  it('words SafeSEH for 32-bit x86 only', async () => {
    const label = 'Safe exception handlers (SafeSEH)';
    expect(row(await render({ dllCharacteristics: base | 0x400 }), label)).toBe(
      'Not needed (no exception handlers)',
    );
    expect(
      row(await render({ loadConfig: { seHandlerTable: 0x405000, seHandlerCount: 3 } }), label),
    ).toBe('Yes, 3 handlers');
    expect(row(await render({ loadConfig: {} }), label)).toBe('No');
    expect(row(await render({}), label)).toBe('No');
    expect(row(await render({ plus: true }), label)).toBeUndefined();
    expect(row(await render({ machine: 0x01c4 }), label)).toBeUndefined();
  });

  it('shows EH continuation metadata only when GuardFlags was read', async () => {
    const label = 'EH continuation metadata';
    expect(row(await render({}), label)).toBeUndefined();
    expect(row(await render({ loadConfig: { guardFlags: 0x400000 } }), label)).toBe('Yes');
    expect(row(await render({ loadConfig: { guardFlags: 0x100 } }), label)).toBe('No');
    expect(row(await render({ loadConfig: { size: 0x58 } }), label)).toBeUndefined();
  });

  it('shows CET compatibility for x64 only', async () => {
    const label = 'CET shadow stack compatible';
    expect(row(await render({ plus: true, exDllCharacteristics: 1 }), label)).toBe('Yes');
    expect(row(await render({ plus: true }), label)).toBe('No');
    expect(row(await render({ exDllCharacteristics: 1 }), label)).toBeUndefined();
    expect(row(await render({ plus: true, machine: 0xaa64 }), label)).toBeUndefined();
  });

  it('puts the new rows before the other loader flags', async () => {
    const html = await render({ plus: true, dllCharacteristics: base | 0x8000, loadConfig: {} });
    expect(html.indexOf('Stack cookies')).toBeGreaterThan(html.indexOf('AppContainer only'));
    expect(html.indexOf('Stack cookies')).toBeLessThan(html.indexOf('Other loader flags'));
  });
});
