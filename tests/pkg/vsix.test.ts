import { describe, expect, it } from 'vitest';
import {
  buildZip,
  expectSafe,
  hasSection,
  html,
  readZip,
  section,
  tableRows,
  value,
} from './zipFixture';

const RLO = String.fromCharCode(0x202e);

function vsixManifest(overrides: { displayName?: string; description?: string } = {}): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="demo" Version="1.2.3" Publisher="acme" TargetPlatform="win32-x64" />
    <DisplayName>${overrides.displayName ?? 'Demo Extension'}</DisplayName>
    <Description xml:space="preserve">${overrides.description ?? 'Does demo things.&#10;&#10;Second paragraph.'}</Description>
    <Tags>markdown,preview, csv</Tags>
    <Categories>Visualization,Other</Categories>
    <GalleryFlags>Public Preview</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.90.0" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="vscode.git,acme.base" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="acme.one,acme.two" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="https://github.com/acme/demo.git" />
    </Properties>
    <License>extension/LICENSE.txt</License>
    <Icon>extension/icon.png</Icon>
  </Metadata>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>`;
}

const packageJson = {
  name: 'demo',
  displayName: 'Demo Extension',
  publisher: 'acme',
  version: '1.2.3',
  engines: { vscode: '^1.90.0' },
  main: './dist/extension.js',
  browser: './dist/web.js',
  activationEvents: ['onLanguage:markdown', 'onCommand:demo.run', 'workspaceContains:**/*.csv'],
  capabilities: {
    untrustedWorkspaces: { supported: 'limited', description: 'x' },
    virtualWorkspaces: { supported: false },
  },
  contributes: {
    commands: [{ command: 'a' }, { command: 'b' }],
    languages: [{ id: 'x' }],
    customEditors: [{ viewType: 'v' }, { viewType: 'w' }, { viewType: 'y' }],
    configuration: { properties: { 'demo.a': {}, 'demo.b': {}, 'demo.c': {} } },
    menus: { 'editor/title': [], 'view/title': [] },
    emptyThing: [],
  },
};

const vsix = (
  extra: Parameters<typeof buildZip>[0] = [],
  json: unknown = packageJson,
): Uint8Array =>
  buildZip([
    { name: 'extension.vsixmanifest', data: vsixManifest() },
    { name: '[Content_Types].xml', data: '<Types/>' },
    {
      name: 'extension/package.json',
      data: typeof json === 'string' ? json : JSON.stringify(json),
    },
    ...extra,
  ]);

describe('readZipPackage: a VS Code extension', () => {
  it('reads the identity and metadata from the vsixmanifest', async () => {
    const info = await readZip(vsix(), 'demo.vsix');
    expect(info.format).toBe('VS Code extension');
    expect(info.title).toBe('Demo Extension 1.2.3');
    expect(value(info, 'Package', 'Identifier')).toBe('acme.demo');
    expect(value(info, 'Package', 'Publisher')).toBe('acme');
    expect(value(info, 'Package', 'Version')).toBe('1.2.3');
    expect(value(info, 'Package', 'Target platform')).toBe('win32-x64');
    expect(value(info, 'Package', 'Requires VS Code')).toBe('^1.90.0');
    expect(value(info, 'Package', 'Categories')).toBe('Visualization, Other');
    expect(value(info, 'Package', 'Tags')).toBe('markdown, preview, csv');
    expect(value(info, 'Package', 'Gallery flags')).toBe('Public Preview');
    expect(value(info, 'Package', 'Licence file')).toBe('extension/LICENSE.txt');
    expect(value(info, 'Package', 'Icon')).toBe('extension/icon.png');
    expect(value(info, 'Package', 'Source')).toBe('https://github.com/acme/demo.git');
    expect(value(info, 'Extension', 'Extension kind')).toBe('workspace');
  });

  it('splits the description into paragraphs and uses its first line as the summary', async () => {
    const info = await readZip(vsix());
    expect(section(info, 'Description')).toMatchObject({
      kind: 'text',
      paragraphs: ['Does demo things.', 'Second paragraph.'],
    });
    expect(info.summary).toBe('Does demo things.');
  });

  it('reads the extension package.json', async () => {
    const info = await readZip(vsix());
    expect(value(info, 'Extension', 'Entry point (Node)')).toBe('./dist/extension.js');
    expect(value(info, 'Extension', 'Entry point (web)')).toBe('./dist/web.js');
    expect(value(info, 'Extension', 'Activation events')).toBe('3');
    expect(value(info, 'Extension', 'Untrusted workspaces')).toBe('limited');
    expect(value(info, 'Extension', 'Virtual workspaces')).toBe('Not supported');
    expect(tableRows(info, 'Activation events')).toEqual([
      ['onLanguage:markdown'],
      ['onCommand:demo.run'],
      ['workspaceContains:**/*.csv'],
    ]);
  });

  it('counts each contribution point, and configuration by its properties', async () => {
    const info = await readZip(vsix());
    expect(tableRows(info, 'Contributes')).toEqual([
      ['commands', '2'],
      ['languages', '1'],
      ['customEditors', '3'],
      ['configuration', '3'],
      ['menus', '2'],
    ]);
  });

  it('lists dependencies and pack members', async () => {
    const info = await readZip(vsix());
    expect(tableRows(info, 'Dependencies')).toEqual([
      ['vscode.git', 'Required'],
      ['acme.base', 'Required'],
      ['acme.one', 'Bundled in the pack'],
      ['acme.two', 'Bundled in the pack'],
    ]);
  });

  it('caps the activation event list but reports the count', async () => {
    const many = {
      ...packageJson,
      activationEvents: Array.from({ length: 80 }, (_, i) => `e${i}`),
    };
    const info = await readZip(vsix([], many));
    expect(value(info, 'Extension', 'Activation events')).toBe('80');
    expect(tableRows(info, 'Activation events').length).toBe(30);
  });

  it('notes a marketplace signature by its presence only', async () => {
    const signed = await readZip(vsix([{ name: '.signature.p7s', data: 'x' }]));
    expect(value(signed, 'Signature', 'Status')).toContain('Marketplace');
    expect(value(signed, 'Signature', 'Signer')).toBeUndefined();
    const sigzip = await readZip(vsix([{ name: 'extension.sigzip', data: 'x' }]));
    expect(hasSection(sigzip, 'Signature')).toBe(true);
    expect(hasSection(await readZip(vsix()), 'Signature')).toBe(false);
  });

  it('reads a deflated vsix', async () => {
    const info = await readZip(
      buildZip([
        { name: 'extension.vsixmanifest', data: vsixManifest(), method: 8 },
        { name: 'extension/package.json', data: JSON.stringify(packageJson), method: 8 },
      ]),
    );
    expect(info.title).toBe('Demo Extension 1.2.3');
    expect(info.warnings).toEqual([]);
  });

  it('falls back to package.json when the manifest is damaged', async () => {
    const info = await readZip(
      buildZip([
        { name: 'extension.vsixmanifest', data: '<PackageManifest><Metadata>' },
        { name: 'extension/package.json', data: JSON.stringify(packageJson) },
      ]),
    );
    expect(info.warnings).toContain('extension.vsixmanifest is not valid XML.');
    expect(info.title).toBe('Demo Extension 1.2.3');
    expect(value(info, 'Package', 'Requires VS Code')).toBe('^1.90.0');
  });

  it('ignores an untranslated %placeholder% display name', async () => {
    const info = await readZip(
      buildZip([
        {
          name: 'extension/package.json',
          data: JSON.stringify({ ...packageJson, displayName: '%name%', description: '%desc%' }),
        },
        {
          name: 'extension.vsixmanifest',
          data: '<PackageManifest><Metadata><Identity Id="demo" Version="1" Publisher="p"/></Metadata></PackageManifest>',
        },
      ]),
    );
    expect(info.title).toBe('demo 1');
    expect(hasSection(info, 'Description')).toBe(false);
  });
});

describe('readZipPackage: a hostile extension', () => {
  it('warns about a package.json that is not JSON or not an object', async () => {
    const broken = await readZip(vsix([], '{not json'));
    expect(broken.warnings).toContain('extension/package.json is not valid JSON.');
    const list = await readZip(vsix([], '[1,2]'));
    expect(list.warnings).toContain('extension/package.json is not a JSON object.');
  });

  it('ignores fields of the wrong type', async () => {
    const info = await readZip(
      vsix([], {
        name: 5,
        main: { a: 1 },
        engines: 'x',
        activationEvents: 'all',
        contributes: { commands: 'many', configuration: [1, { properties: 7 }], menus: 3 },
        extensionDependencies: [1, null, 'ok.dep'],
        capabilities: { untrustedWorkspaces: 'yes' },
      }),
    );
    expect(value(info, 'Extension', 'Entry point (Node)')).toBeUndefined();
    expect(hasSection(info, 'Contributes')).toBe(false);
  });

  it('warns when package.json is larger than the cap', async () => {
    const big = JSON.stringify({ name: 'x', pad: 'a'.repeat(3 * 1024 * 1024) });
    const info = await readZip(vsix([], big));
    expect(info.warnings).toContain('extension/package.json could not be read.');
  });

  it('escapes markup and strips direction overrides', async () => {
    const info = await readZip(
      buildZip([
        {
          name: 'extension.vsixmanifest',
          data: vsixManifest({
            displayName: `&lt;img src=x onerror=1&gt;${RLO}`,
            description: '&lt;script&gt;alert(1)&lt;/script&gt;',
          }),
        },
        {
          name: 'extension/package.json',
          data: JSON.stringify({ homepage: `https://x/${RLO}y`, contributes: { '<b>k</b>': [1] } }),
        },
      ]),
    );
    const page = html(info);
    expect(page).toContain('&lt;img src=x onerror=1&gt;');
    expect(page).not.toContain('<img src=x');
    expect(page).not.toContain('<script>alert');
    expect(page).not.toContain('<b>k');
    expect(page).not.toContain(RLO);
  });

  it('survives truncation and corruption', async () => {
    await expectSafe(vsix([{ name: '.signature.p7s', data: 'x' }]), 'x.vsix');
  });
});
