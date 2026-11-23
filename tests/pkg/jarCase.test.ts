// OpenJDK's zip reader decides which members are signature files with ASCII-only
// case folding on the raw name bytes (ZipFile.java, jdk-21+35: `b | 0x20`).
// Unicode folding must not promote a name into META-INF or onto a signature
// extension. Non-ASCII characters are built from code points, never typed.
import { describe, expect, it } from 'vitest';
import { asciiLower, isJarManifestName } from '../../src/pkg/ascii';
import { buildSignedData } from '../pe/fixture';
import { buildZip, hasSection, readZip, value, type FixtureEntry } from './zipFixture';

const DOTLESS_I = String.fromCharCode(0x131);
const LONG_S = String.fromCharCode(0x17f);
const KELVIN = String.fromCharCode(0x212a);

const signedBy = (name: string): Uint8Array =>
  buildSignedData({ subject: { commonName: name }, issuer: { commonName: 'CA' } });
const SF = 'Signature-Version: 1.0\n';
const jar = (more: FixtureEntry[]): Uint8Array =>
  buildZip([{ name: 'META-INF/MANIFEST.MF', data: 'Manifest-Version: 1.0\n' }, ...more]);

describe('ASCII-only case folding in META-INF names', () => {
  it('does not treat a directory spelled with a dotless i as META-INF', async () => {
    const dir = `META-${DOTLESS_I}NF`;
    expect(`${dir}/DEMO.SF`.toUpperCase()).toBe('META-INF/DEMO.SF');
    const info = await readZip(
      jar([
        { name: `${dir}/DEMO.SF`, data: SF },
        { name: `${dir}/DEMO.RSA`, data: signedBy('Dotless') },
      ]),
    );
    expect(hasSection(info, 'Signature')).toBe(false);
    expect(info.warnings).toEqual([]);
  });

  it('does not treat a long s or a Kelvin sign in the extension as a signature extension', async () => {
    expect(`DEMO.${LONG_S}F`.toUpperCase()).toBe('DEMO.SF');
    const info = await readZip(
      jar([
        { name: `META-INF/DEMO.${LONG_S}F`, data: SF },
        { name: `META-INF/DEMO.R${LONG_S}A`, data: signedBy('Long s') },
      ]),
    );
    // The block is not a signature block and the .SF look-alike is not a .SF.
    expect(hasSection(info, 'Signature')).toBe(false);
    expect(info.warnings).toEqual([]);
    const kelvin = await readZip(
      jar([
        { name: 'META-INF/DEMO.SF', data: SF },
        { name: `META-INF/DEMO.RSA${KELVIN}`, data: signedBy('Kelvin') },
      ]),
    );
    expect(hasSection(kelvin, 'Signature')).toBe(false);
  });

  it('still pairs an ordinary mixed-case ASCII pair', async () => {
    const info = await readZip(
      jar([
        { name: 'meta-inf/Demo.Sf', data: SF },
        { name: 'Meta-INF/DEMO.rSa', data: signedBy('Mixed') },
      ]),
    );
    expect(value(info, 'Signature', 'Signer')).toBe('Mixed');
  });

  it('pairs after the structure is accepted by the full upper-cased base name, as the verifier does', async () => {
    const info = await readZip(
      jar([
        { name: `META-INF/dem${DOTLESS_I}.SF`, data: SF },
        { name: 'META-INF/DEMI.RSA', data: signedBy('Paired') },
      ]),
    );
    expect(value(info, 'Signature', 'Signer')).toBe('Paired');
  });

  it('does not fold a Kelvin sign or a dotless i into the manifest name or attribute names', () => {
    expect(isJarManifestName('Meta-Inf/Manifest.Mf')).toBe(true);
    expect(isJarManifestName(`META-${DOTLESS_I}NF/MANIFEST.MF`)).toBe(false);
    expect(isJarManifestName(`META-INF/MANIFEST.M${KELVIN}`)).toBe(false);
    expect(asciiLower('Package')).toBe('package');
    expect(asciiLower(`Pac${KELVIN}age`)).toBe(`pac${KELVIN}age`);
    expect(`Pac${KELVIN}age`.toLowerCase()).toBe('package');
  });
});
