import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const EXT_ID = 'OwenPKent.markcopy';

suite('MarkCopy integration', () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} not found`);
    await ext.activate();
  });

  test('registers its commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('markcopy.openPreview'), 'markcopy.openPreview missing');
    assert.ok(
      commands.includes('markcopy.copyDocumentAsRichText'),
      'markcopy.copyDocumentAsRichText missing',
    );
    assert.ok(commands.includes('markcopy.openSource'), 'markcopy.openSource missing');
    assert.ok(commands.includes('markcopy.openRendered'), 'markcopy.openRendered missing');
    assert.ok(commands.includes('markcopy.openSettings'), 'markcopy.openSettings missing');
  });

  test('has the expected configuration defaults', () => {
    const cfg = vscode.workspace.getConfiguration('markcopy');
    assert.strictEqual(cfg.get('styleProfile'), 'github');
    assert.strictEqual(cfg.get('syncScroll'), true);
    assert.strictEqual(cfg.get('theme'), 'auto');
    assert.strictEqual(cfg.get('autoPreview'), true);
    assert.strictEqual(cfg.get('csv.delimiter'), 'auto');
    assert.strictEqual(cfg.get('csv.headerRow'), true);
    assert.strictEqual(cfg.get('csv.maxRows'), 5000);
    // Reading these through the real configuration is what catches a contribution
    // key that does not match the key the code reads: `cfg.get('pdf.pageSize')`
    // would just keep returning its hardcoded default, and every unit test would
    // still pass while the setting did nothing.
    assert.strictEqual(cfg.get('pdf.pageSize'), 'Letter');
    assert.strictEqual(cfg.get('pdf.browserPath'), '');
    assert.strictEqual(cfg.get('stl.showGrid'), true);
    assert.strictEqual(cfg.get('stl.meshColor'), '#8ab4f8');
  });

  // Which editor claims a .stl lives in customEditors.test.ts, with the rest of
  // the filename-selector assertions.

  // The extension contributes the `csv` and `tsv` language ids itself. If that
  // contribution ever regressed, `onLanguage:csv` would never fire and the CSV
  // preview would silently never activate.
  test('claims the csv and tsv language ids', async () => {
    const languages = await vscode.languages.getLanguages();
    assert.ok(languages.includes('csv'), 'csv language id not registered');
    assert.ok(languages.includes('tsv'), 'tsv language id not registered');
  });

  test('a .csv file is recognized as the csv language', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'markcopy-')), 'data.csv');
    fs.writeFileSync(file, 'name,qty\nWidget,3\n');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    assert.strictEqual(doc.languageId, 'csv');
  });

  test('opening the preview creates a preview tab', async () => {
    const doc = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content: '# Hi\n\nSome **bold** text and a [link](https://example.com).\n',
    });
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('markcopy.openPreview');
    await new Promise((resolve) => setTimeout(resolve, 800));

    const labels = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .map((tab) => tab.label);
    assert.ok(
      labels.some((label) => label.startsWith('Preview')),
      `expected a MarkCopy preview tab, saw: ${JSON.stringify(labels)}`,
    );
  });

  test('copy-whole-document command runs without throwing', async () => {
    await vscode.commands.executeCommand('markcopy.copyDocumentAsRichText');
  });

  /**
   * Poll `probe` until it reports true, or give up after `timeoutMs`.
   *
   * Waiting on the condition rather than on a stopwatch is what keeps a loaded
   * CI runner from failing a test that is only ever about tab bookkeeping. The
   * swap is two awaits deep (`vscode.openWith` resolves, then the source tab is
   * closed), so a fixed sleep either has to be long enough for the worst runner
   * or it flakes on the assertion that the source tab is gone.
   */
  async function waitUntil(probe: () => boolean, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!probe() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  const allTabs = (): readonly vscode.Tab[] =>
    vscode.window.tabGroups.all.flatMap((group) => group.tabs);

  const customTabsOn = (uri: vscode.Uri, viewType: string): readonly vscode.Tab[] =>
    allTabs().filter(
      (tab) =>
        tab.input instanceof vscode.TabInputCustom &&
        tab.input.viewType === viewType &&
        tab.input.uri.toString() === uri.toString(),
    );

  const textTabsOn = (uri: vscode.Uri): readonly vscode.Tab[] =>
    allTabs().filter(
      (tab) =>
        tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString(),
    );

  /**
   * Assert that focusing `file` swapped its tab to the `viewType` preview.
   *
   * Both halves matter and only together: that the preview opened is the easy
   * one, and that the text editor it replaced is gone is what makes this a swap
   * in one group rather than the split auto-preview used to open.
   */
  async function assertSwapsToPreview(file: string, viewType: string): Promise<void> {
    // The swap is what auto-preview does when there is no side panel; with one
    // open it retargets that panel instead, which is the bargain "Open Rich
    // Preview to the Side" makes. An earlier test in this suite leaves a panel
    // behind, so clear the slate rather than testing the other branch by
    // accident.
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await waitUntil(() => allTabs().length === 0);

    const uri = vscode.Uri.file(file);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    await waitUntil(() => customTabsOn(uri, viewType).length > 0 && textTabsOn(uri).length === 0);

    const seen = JSON.stringify(allTabs().map((tab) => tab.label));
    assert.ok(
      customTabsOn(uri, viewType).length > 0,
      `expected ${path.basename(file)} to swap to the ${viewType} preview, saw: ${seen}`,
    );
    assert.strictEqual(
      textTabsOn(uri).length,
      0,
      `the source tab should have been swapped, not joined, saw: ${seen}`,
    );
  }

  test('focusing an on-disk Markdown file swaps its tab to the preview', async () => {
    // Auto-preview only fires for real files on disk (scheme 'file'), so write a
    // temp file rather than using an untitled document.
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'markcopy-')), 'auto.md');
    fs.writeFileSync(file, '# Auto\n\nOpened by focus, no command needed.\n');

    await assertSwapsToPreview(file, 'markcopy.markdownPreview');
  });

  test('focusing an on-disk CSV file swaps its tab to the grid', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'markcopy-')), 'sales.csv');
    fs.writeFileSync(file, 'region,units\n"North, America",1284\nEMEA,976\n');

    await assertSwapsToPreview(file, 'markcopy.csvPreview');
  });

  test('a burst of swap requests still leaves exactly one preview', async () => {
    // The same shape the LaTeX path needed `openingTex` for, on the Markdown one:
    // restoring a folder churns the active editor several times with nothing
    // awaited between passes, `vscode.openWith` is asynchronous, and its target
    // group is re-evaluated per call. Without a synchronous claim each pass sees
    // "no preview yet" and starts another, and one file ends up with two live
    // retained-context webviews re-rendering on every keystroke. Firing without
    // awaiting is the whole point; awaiting between calls hides the bug.
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await waitUntil(() => allTabs().length === 0);

    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'markcopy-')), 'burst.md');
    fs.writeFileSync(file, '# Burst\n\nOpened eight times at once.\n');
    const uri = vscode.Uri.file(file);
    await vscode.workspace.openTextDocument(uri);

    for (let i = 0; i < 8; i++) {
      void vscode.commands.executeCommand('markcopy.openRendered', uri);
    }
    await waitUntil(() => customTabsOn(uri, 'markcopy.markdownPreview').length > 0);
    await new Promise((resolve) => setTimeout(resolve, 500));

    const previews = customTabsOn(uri, 'markcopy.markdownPreview');
    assert.strictEqual(
      previews.length,
      1,
      `a burst should collapse to one preview, saw ${previews.length}`,
    );
  });
});
