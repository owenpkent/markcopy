import { describe, expect, it } from 'vitest';
import { bytesSource, formatBytes, ICON_MEDIA_ID, readPe, renderPeHtml } from '../../src/pe';
import { buildPe, buildSignedData, iconBitmap, pngStub, type PeSpec } from './fixture';

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
    // A ContentInfo that says it is SignedData and holds an empty one: a
    // signature entry by its own account, with no signer to walk to.
    const emptySignedData = Uint8Array.from([
      0x30, 0x0f, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02, 0xa0, 0x02,
      0x30, 0x00,
    ]);
    const html = await render({ certificate: emptySignedData });
    expect(html).toContain('Embedded signature present, not verified by MarkCopy');
    expect(html).not.toContain('Signer</td>');
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
    expect(html).toContain('<td>At start</td>');
    expect(html).toContain('<td>On first use</td>');
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
