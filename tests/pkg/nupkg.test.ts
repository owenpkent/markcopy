import { describe, expect, it } from 'vitest';
import { buildSignedData } from '../pe/fixture';
import {
  buildZip,
  expectSafe,
  hasSection,
  html,
  readZip,
  section,
  tableRows,
  value,
  type FixtureEntry,
} from './zipFixture';

const RLO = String.fromCharCode(0x202e);

const nuspec = (inner: string): string =>
  `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd">
  <metadata>${inner}</metadata>
</package>`;

const FULL = nuspec(`
    <id>Contoso.Widgets</id>
    <version>3.1.0-beta.2</version>
    <title>Widgets</title>
    <authors>Contoso, Ada</authors>
    <owners>contoso</owners>
    <description>Widgets for everything.

Second paragraph.</description>
    <summary>Widget library</summary>
    <license type="expression">MIT</license>
    <licenseUrl>https://aka.ms/deprecateLicenseUrl</licenseUrl>
    <projectUrl>https://contoso.example/widgets</projectUrl>
    <repository type="git" url="https://github.com/contoso/widgets" commit="abc123" />
    <tags>widgets ui contoso</tags>
    <releaseNotes>First notes paragraph.

Later paragraph.</releaseNotes>
    <requireLicenseAcceptance>false</requireLicenseAcceptance>
    <developmentDependency>true</developmentDependency>
    <minClientVersion>4.3.0</minClientVersion>
    <packageTypes><packageType name="Dependency" /><packageType name="DotnetTool" /></packageTypes>
    <dependencies>
      <group targetFramework="net6.0">
        <dependency id="Newtonsoft.Json" version="[13.0.1, )" exclude="Build" />
        <dependency id="Serilog" version="3.0.0" />
      </group>
      <group targetFramework=".NETStandard2.0" />
      <group>
        <dependency id="Any.Dep" version="1.0.0" />
      </group>
    </dependencies>`);

const pkg = (spec = FULL, extra: FixtureEntry[] = []): Uint8Array =>
  buildZip([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'Contoso.Widgets.nuspec', data: spec },
    { name: 'lib/net6.0/Contoso.Widgets.dll', data: 'MZ' },
    { name: 'lib/netstandard2.0/Contoso.Widgets.dll', data: 'MZ' },
    ...extra,
  ]);

describe('readZipPackage: a NuGet package', () => {
  it('reads the identity from the nuspec', async () => {
    const info = await readZip(pkg(), 'Contoso.Widgets.3.1.0-beta.2.nupkg');
    expect(info.format).toBe('NuGet package');
    expect(info.title).toBe('Contoso.Widgets 3.1.0-beta.2');
    expect(info.summary).toBe('Widget library');
    expect(value(info, 'Package', 'Id')).toBe('Contoso.Widgets');
    expect(value(info, 'Package', 'Title')).toBe('Widgets');
    expect(value(info, 'Package', 'Version')).toBe('3.1.0-beta.2');
    expect(value(info, 'Package', 'Authors')).toBe('Contoso, Ada');
    expect(value(info, 'Package', 'Owners')).toBe('contoso');
    expect(value(info, 'Package', 'License')).toBe('MIT');
    expect(value(info, 'Package', 'Homepage')).toBe('https://contoso.example/widgets');
    expect(value(info, 'Package', 'Repository')).toBe('https://github.com/contoso/widgets');
    expect(value(info, 'Package', 'Repository type')).toBe('git');
    expect(value(info, 'Package', 'Commit')).toBe('abc123');
    expect(value(info, 'Package', 'Tags')).toBe('widgets ui contoso');
    expect(value(info, 'Package', 'Requires license acceptance')).toBe('false');
    expect(value(info, 'Package', 'Development dependency')).toBe('true');
    expect(value(info, 'Package', 'Minimum NuGet client')).toBe('4.3.0');
    expect(value(info, 'Package', 'Package types')).toBe('Dependency, DotnetTool');
  });

  it('shows the description and the first paragraph of the release notes', async () => {
    const info = await readZip(pkg());
    expect(section(info, 'Description')).toMatchObject({
      paragraphs: ['Widgets for everything.', 'Second paragraph.'],
    });
    expect(section(info, 'Release notes')).toMatchObject({
      paragraphs: ['First notes paragraph.'],
    });
  });

  it('groups dependencies by target framework', async () => {
    const info = await readZip(pkg());
    expect(tableRows(info, 'Dependencies')).toEqual([
      ['net6.0', 'Newtonsoft.Json', '[13.0.1, )'],
      ['net6.0', 'Serilog', '3.0.0'],
      ['.NETStandard2.0', '(none)', ''],
      ['(any)', 'Any.Dep', '1.0.0'],
    ]);
  });

  it('shows a licence file and a deprecated licence URL', async () => {
    const file = await readZip(
      pkg(nuspec('<id>a</id><version>1</version><license type="file">LICENSE.txt</license>')),
    );
    expect(value(file, 'Package', 'License')).toBe('LICENSE.txt (file)');
    const url = await readZip(
      pkg(nuspec('<id>a</id><version>1</version><licenseUrl>https://x/l</licenseUrl>')),
    );
    expect(value(url, 'Package', 'License')).toBe('https://x/l');
  });

  it('lists the target frameworks and runtimes in the layout', async () => {
    const info = await readZip(
      pkg(FULL, [
        { name: 'ref/net6.0/Contoso.Widgets.dll', data: 'MZ' },
        { name: 'runtimes/win-x64/native/w.dll', data: 'MZ' },
        { name: 'runtimes/linux-x64/native/w.so', data: 'x' },
        { name: 'analyzers/dotnet/cs/a.dll', data: 'MZ' },
      ]),
    );
    expect(value(info, 'Targets', 'Libraries for')).toBe('net6.0, netstandard2.0');
    expect(value(info, 'Targets', 'Reference assemblies for')).toBe('net6.0');
    expect(value(info, 'Targets', 'Runtimes')).toBe('win-x64, linux-x64');
    expect(value(info, 'Targets', 'Analyzers')).toBe('Yes');
  });

  it('calls out build files and install scripts, which run code', async () => {
    const info = await readZip(
      pkg(FULL, [
        { name: 'build/Contoso.Widgets.targets', data: '<Project/>' },
        { name: 'buildTransitive/Contoso.Widgets.props', data: '<Project/>' },
        { name: 'build/readme.txt', data: 'x' },
        { name: 'tools/install.ps1', data: 'Write-Host hi' },
        { name: 'tools/init.ps1', data: 'x' },
        { name: 'tools/other.exe', data: 'MZ' },
      ]),
    );
    expect(value(info, 'Code that runs', 'Build integration')).toBe(
      'build/Contoso.Widgets.targets, buildTransitive/Contoso.Widgets.props',
    );
    expect(value(info, 'Code that runs', 'Install scripts')).toBe(
      'tools/install.ps1, tools/init.ps1',
    );
    expect(value(info, 'Code that runs', 'Tools folder')).toBe('3 files');
    expect((section(info, 'Code that runs') as { note?: string }).note).toContain('Read them');
  });

  it('has no code-that-runs section for a plain library', async () => {
    expect(hasSection(await readZip(pkg()), 'Code that runs')).toBe(false);
  });

  it('reports a package signature and the signer it names', async () => {
    const der = buildSignedData({
      subject: { commonName: 'Contoso Publisher', organization: 'Contoso Ltd' },
      issuer: { commonName: 'NuGet CA' },
    });
    const info = await readZip(pkg(FULL, [{ name: '.signature.p7s', data: der }]));
    expect(value(info, 'Signature', 'Status')).toContain('NuGet package');
    expect(value(info, 'Signature', 'Signer')).toBe('Contoso Publisher');
    expect(value(info, 'Signature', 'Issued by')).toBe('NuGet CA');
    expect(hasSection(await readZip(pkg()), 'Signature')).toBe(false);
  });

  it('recognises a symbol package', async () => {
    expect((await readZip(pkg(), 'x.snupkg')).format).toBe('NuGet symbol package');
  });

  it('reads a deflated nuspec', async () => {
    const bytes = buildZip([{ name: 'a.nuspec', data: FULL, method: 8 }]);
    expect((await readZip(bytes)).title).toBe('Contoso.Widgets 3.1.0-beta.2');
  });
});

describe('readZipPackage: a hostile NuGet package', () => {
  it('warns about a nuspec that is not XML or has no metadata', async () => {
    const broken = await readZip(pkg('<package><metadata>'));
    expect(broken.warnings).toContain('The nuspec is not valid XML.');
    expect(broken.format).toBe('NuGet package');
    const empty = await readZip(pkg('<package/>'));
    expect(empty.warnings).toContain('The nuspec has no package metadata.');
  });

  it('caps the dependency rows', async () => {
    const deps = Array.from(
      { length: 2600 },
      (_, i) => `<dependency id="p${i}" version="1"/>`,
    ).join('');
    const info = await readZip(
      pkg(nuspec(`<id>a</id><version>1</version><dependencies>${deps}</dependencies>`)),
    );
    const table = section(info, 'Dependencies') as { rows: string[][]; note?: string };
    expect(table.rows.length).toBe(200);
    expect(table.note).toBe('Showing the first 200 of 2,000 dependencies.');
  });

  it('caps the framework folder names', async () => {
    const folders = Array.from({ length: 100 }, (_, i) => ({
      name: `lib/tfm${i}/a.dll`,
      data: 'x',
    }));
    const info = await readZip(pkg(FULL, folders));
    expect(value(info, 'Targets', 'Libraries for')!.split(', ').length).toBe(64);
  });

  it('warns about an unreadable signature but still reports it', async () => {
    const info = await readZip(pkg(FULL, [{ name: '.signature.p7s', data: 'junk' }]));
    expect(value(info, 'Signature', 'Status')).toContain('present');
    expect(value(info, 'Signature', 'Signer')).toBeUndefined();
  });

  it('escapes markup and strips direction overrides', async () => {
    const info = await readZip(
      pkg(
        nuspec(
          `<id>&lt;img src=x onerror=1&gt;</id><version>1</version><authors>a${RLO}b</authors><description>&lt;script&gt;x&lt;/script&gt;</description><tags>&lt;b&gt;t</tags>`,
        ),
      ),
    );
    const page = html(info);
    expect(page).toContain('&lt;img src=x onerror=1&gt;');
    expect(page).not.toContain('<img src=x');
    expect(page).not.toContain('<script>x');
    expect(page).not.toContain('<b>t');
    expect(page).not.toContain(RLO);
  });

  it('survives truncation and corruption', async () => {
    const der = buildSignedData({ subject: { commonName: 'S' }, issuer: { commonName: 'I' } });
    await expectSafe(
      pkg(FULL, [
        { name: 'build/a.targets', data: '<Project/>' },
        { name: '.signature.p7s', data: der },
      ]),
      'x.nupkg',
    );
  });
});

describe('readZipPackage: bounded XML in a NuGet package', () => {
  it('warns about a nuspec nested past the depth bound', async () => {
    const info = await readZip(pkg(`${'<a>'.repeat(300)}${'</a>'.repeat(300)}`));
    expect(info.warnings).toContain('The nuspec is not valid XML.');
  });

  it('caps empty dependency groups as well as dependencies', async () => {
    const groups = Array.from(
      { length: 3000 },
      (_, i) => `<group targetFramework="net${i}"/>`,
    ).join('');
    const info = await readZip(
      pkg(nuspec(`<id>a</id><version>1</version><dependencies>${groups}</dependencies>`)),
    );
    const table = section(info, 'Dependencies') as { rows: string[][]; note?: string };
    expect(table.rows.length).toBe(200);
    expect(table.note).toBe('Showing the first 200 of 2,000 dependencies.');
  });
});

describe('readZipPackage: NuGet entry identity', () => {
  it('uses the real nuspec, not an earlier entry that cleans to the same name', async () => {
    const info = await readZip(
      buildZip([
        { name: `a${RLO}.nuspec`, data: nuspec('<id>decoy</id><version>9</version>') },
        { name: 'a.nuspec', data: nuspec('<id>real</id><version>1</version>') },
      ]),
    );
    expect(info.title).toBe('real 1');
  });

  it('accepts an upper-case extension, as NuGet does', async () => {
    const info = await readZip(
      buildZip([{ name: 'A.NUSPEC', data: nuspec('<id>x</id><version>2</version>') }]),
    );
    expect(info.title).toBe('x 2');
  });
});
