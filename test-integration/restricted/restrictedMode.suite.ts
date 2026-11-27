// MarkCopy in Restricted Mode, in a real VS Code.
//
// Run by `npm run test:integration:restricted`, never by the main run:
// @vscode/test-electron always passes --disable-workspace-trust, which makes
// every workspace trusted, so launch.mjs starts VS Code itself without it, in a
// folder the fresh user-data directory has never trusted.
import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';

const EXT_ID = 'OwenPKent.markcopy';
const TEX_VIEW = 'markcopy.texPreview';
// Must match the value in fixture/.vscode/settings.json.
const PROBE_ROOT = 'trust-probe/root.tex';
const UNTRUSTED_TEXT = 'LaTeX compilation requires a trusted VS Code workspace.';

interface TexStatus {
  state: string;
  text?: string;
  seq: number;
}

const allTabs = (): readonly vscode.Tab[] =>
  vscode.window.tabGroups.all.flatMap((group) => group.tabs);

function fixtureFile(name: string): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'the run opened no workspace folder');
  return vscode.Uri.file(path.join(folder.uri.fsPath, name));
}

async function waitFor<T>(probe: () => PromiseLike<T | undefined> | T | undefined): Promise<T> {
  const deadline = Date.now() + 20000;
  for (;;) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    assert.ok(Date.now() < deadline, 'timed out waiting for the condition');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

suite('MarkCopy in Restricted Mode', () => {
  suiteSetup(async () => {
    // Fail loudly if the launch did not produce an untrusted workspace, so
    // nothing below can pass by running in a trusted one.
    assert.strictEqual(
      vscode.workspace.isTrusted,
      false,
      'the workspace is trusted: the run did not start in Restricted Mode',
    );
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} not found`);
    await ext.activate();
  });

  test('declares limited support and lists its restricted settings', () => {
    const caps =
      vscode.extensions.getExtension(EXT_ID)?.packageJSON.capabilities?.untrustedWorkspaces;
    assert.strictEqual(caps?.supported, 'limited');
    for (const key of [
      'markcopy.tex.compile',
      'markcopy.tex.engine',
      'markcopy.tex.enginePath',
      'markcopy.tex.rootFile',
      'markcopy.video.ffmpegPath',
      'markcopy.pdf.browserPath',
      'markcopy.allowRemoteImages',
    ]) {
      assert.ok(caps.restrictedConfigurations.includes(key), `${key} is not restricted`);
    }
  });

  test('is active and still opens the Markdown preview', async () => {
    assert.strictEqual(vscode.extensions.getExtension(EXT_ID)?.isActive, true);
    const doc = await vscode.workspace.openTextDocument(fixtureFile('notes.md'));
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('markcopy.openPreview');
    // The panel is titled `Preview <file>` (src/extension.ts) and its tab input
    // is a webview whose viewType carries the view id. Either identifies it, so
    // a change to one of them does not fail this test for the wrong reason.
    const isPreview = (tab: vscode.Tab): boolean =>
      tab.label === 'Preview notes.md' ||
      (tab.input instanceof vscode.TabInputWebview &&
        tab.input.viewType.includes('markdownPreview'));
    try {
      await waitFor(() => (allTabs().some(isPreview) ? true : undefined));
    } catch {
      assert.fail(
        `no Markdown preview tab opened in Restricted Mode, saw: ${JSON.stringify(
          allTabs().map((tab) => tab.label),
        )}`,
      );
    }
  });

  test('a workspace value for a restricted setting is ignored', () => {
    const cfg = vscode.workspace.getConfiguration('markcopy', fixtureFile('sample.tex'));
    // The fixture's .vscode/settings.json sets both. The unrestricted one
    // applies, which shows the file was read; the restricted one must not.
    // rootFile has no machine scope, so a workspace may set it: the trusted
    // control (test-integration/trusted) proves the same value applies there.
    assert.strictEqual(cfg.get('theme'), 'dark', 'workspace settings were not read at all');
    assert.notStrictEqual(
      cfg.get('tex.rootFile'),
      PROBE_ROOT,
      'a restricted workspace setting applied',
    );
    assert.strictEqual(cfg.get('tex.rootFile'), '');
  });

  test('the LaTeX preview does not compile and says why', async () => {
    const uri = fixtureFile('sample.tex');
    await vscode.commands.executeCommand('vscode.openWith', uri, TEX_VIEW);
    await waitFor(() =>
      allTabs().some(
        (tab) => tab.input instanceof vscode.TabInputCustom && tab.input.viewType === TEX_VIEW,
      )
        ? true
        : undefined,
    );
    // The preview reports once its webview is ready.
    const status = await waitFor(() =>
      vscode.commands.executeCommand<TexStatus | undefined>('markcopy.tex.status', uri),
    );
    assert.strictEqual(status.state, 'unavailable');
    assert.strictEqual(status.text, UNTRUSTED_TEXT);

    // A manual Compile press is refused the same way, never started. The
    // cached status above already says so, so require a newer post: only a run
    // that reached the compile session can produce one. recompileTex acts on the
    // focused LaTeX preview, so check that is the one in front.
    const front = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    assert.ok(
      front instanceof vscode.TabInputCustom && front.viewType === TEX_VIEW,
      'the LaTeX preview is not the active editor',
    );
    const before = status.seq;
    await vscode.commands.executeCommand('markcopy.recompileTex');
    const after = await waitFor(async () => {
      const next = await vscode.commands.executeCommand<TexStatus | undefined>(
        'markcopy.tex.status',
        uri,
      );
      return next && next.seq > before ? next : undefined;
    });
    assert.strictEqual(after.state, 'unavailable');
    assert.strictEqual(after.text, UNTRUSTED_TEXT);
  });
});
