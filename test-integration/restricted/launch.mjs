// Runs test-integration/restricted/*.suite.js in a VS Code that opens a folder
// in Restricted Mode.
//
// Why not .vscode-test.mjs: @vscode/test-electron's runTests always adds
// --disable-workspace-trust (node_modules/@vscode/test-electron/out/runTest.js),
// and VS Code then reports every workspace trusted
// (isWorkspaceTrustEnabled returns false when that flag is set). A launchArgs
// entry cannot undo it, so this script spawns VS Code itself with the same
// arguments minus that flag. It still uses test-electron to download VS Code.
//
// Restricted Mode needs three things, all set up here:
//   - trust enabled (the default) and no startup prompt: a user-data
//     directory whose settings.json sets security.workspace.trust.startupPrompt
//     to "never";
//   - a folder VS Code has no trust record for: a fresh copy of the fixture in
//     a fresh temp directory, with a fresh user-data directory;
//   - the extension's own settings left alone.
import process from 'node:process';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scratch = mkdtempSync(join(tmpdir(), 'markcopy-restricted-'));
const workspace = join(scratch, 'workspace');
const userData = join(scratch, 'user-data');
const extensions = join(scratch, 'extensions');

cpSync(join(root, 'test-integration', 'restricted', 'fixture'), workspace, { recursive: true });
mkdirSync(join(userData, 'User'), { recursive: true });
mkdirSync(extensions, { recursive: true });
writeFileSync(
  join(userData, 'User', 'settings.json'),
  JSON.stringify(
    {
      'security.workspace.trust.enabled': true,
      'security.workspace.trust.startupPrompt': 'never',
      'security.workspace.trust.banner': 'never',
      'window.restoreWindows': 'none',
      'workbench.startupEditor': 'none',
      'telemetry.telemetryLevel': 'off',
    },
    null,
    2,
  ),
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

let code;
try {
  const executable = await downloadAndUnzipVSCode();
  const child = spawn(
    executable,
    [
      workspace,
      '--no-sandbox',
      '--disable-gpu-sandbox',
      '--disable-updates',
      '--skip-welcome',
      '--skip-release-notes',
      '--no-cached-data',
      // Deliberately no --disable-workspace-trust.
      `--user-data-dir=${userData}`,
      `--extensions-dir=${extensions}`,
      `--extensionDevelopmentPath=${root}`,
      `--extensionTestsPath=${join(root, 'out', 'restricted', 'index.js')}`,
    ],
    { stdio: 'inherit', env },
  );
  code = await new Promise((done) => {
    child.on('exit', (exitCode) => done(exitCode ?? 1));
    child.on('error', () => done(1));
  });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(code);
