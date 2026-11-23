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
    const html = await render({ certificate: new Uint8Array(40).fill(0x41) });
    expect(html).toContain('not verified by MarkCopy');
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
