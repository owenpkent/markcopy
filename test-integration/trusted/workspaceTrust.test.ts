// Trusted control for test-integration/restricted/restrictedMode.suite.ts.
// This run opens test-integration/trusted/fixture (see .vscode-test.mjs), which
// carries the same workspace value for a restricted setting as the Restricted
// Mode fixture. Here the workspace is trusted, so the value must apply. Without
// this, the restricted suite could pass because the value is ignored everywhere.
import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Workspace settings in a trusted workspace', () => {
  test('a restricted setting set by the workspace takes effect', async () => {
    assert.strictEqual(vscode.workspace.isTrusted, true, 'the workspace is not trusted');
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'the run opened no workspace folder');
    await vscode.extensions.getExtension('OwenPKent.markcopy')?.activate();
    const cfg = vscode.workspace.getConfiguration('markcopy', folder.uri);
    assert.strictEqual(cfg.get('theme'), 'dark', 'workspace settings were not read at all');
    assert.strictEqual(cfg.get('tex.rootFile'), 'trust-probe/root.tex');
  });
});
