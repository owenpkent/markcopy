// The custom editors, in a real VS Code.
//
// A custom editor is contributed entirely through package.json: a viewType, a
// filename selector, and a priority. None of that is reachable from a unit test,
// and getting it wrong fails silently in the worst way. A selector that does not
// match leaves a workbook opening as binary junk in the text editor, which is
// exactly what someone installs this to avoid, and every test outside VS Code
// still passes.
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const XLSX_VIEW = 'markcopy.xlsxPreview';
const PDF_VIEW = 'markcopy.pdfPreview';
const STL_VIEW = 'markcopy.stlPreview';
const VIDEO_VIEW = 'markcopy.videoPreview';
const MARKDOWN_VIEW = 'markcopy.markdownPreview';
const CSV_VIEW = 'markcopy.csvPreview';
const TEX_VIEW = 'markcopy.texPreview';

/**
 * Poll `probe` until it returns something, or give up.
 *
 * `vscode.open` resolves before the tab is necessarily in `tabGroups`. Waiting
 * on the condition rather than on a stopwatch is what keeps a loaded CI runner
 * from failing a test that is only ever about a filename selector.
 */
async function waitFor<T>(probe: () => T | undefined, timeoutMs = 5000): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() >= deadline) {
      return undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** A copy of a repo fixture in a temp dir, so a test never edits the original. */
function fixture(name: string): vscode.Uri {
  // Compiled to out/, so the repo root is one level up.
  const source = path.resolve(__dirname, '..', name);
  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'markcopy-')), name);
  fs.copyFileSync(source, target);
  return vscode.Uri.file(target);
}

/** The viewTypes of every custom-editor tab currently open. */
function customTabs(): { viewType: string; uri: string }[] {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .map((tab) => tab.input)
    .filter((input): input is vscode.TabInputCustom => input instanceof vscode.TabInputCustom)
    .map((input) => ({ viewType: input.viewType, uri: input.uri.toString() }));
}

async function closeEverything(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

suite('MarkCopy custom editors', () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension('OwenPKent.markcopy');
    assert.ok(ext, 'extension not found');
    await ext.activate();
  });

  teardown(closeEverything);

  test('a workbook opens in the sheet preview, not in the text editor', async () => {
    const uri = fixture('sample.xlsx');
    // No viewType given: this is the association a double-click in the Explorer
    // follows, which is what the manifest's `"priority": "default"` buys.
    await vscode.commands.executeCommand('vscode.open', uri);

    const open = customTabs();
    assert.ok(
      open.some((tab) => tab.viewType === XLSX_VIEW && tab.uri === uri.toString()),
      `expected a ${XLSX_VIEW} tab, saw: ${JSON.stringify(open)}`,
    );
  });

  test('a PDF opens in the PDF viewer', async () => {
    // sample.pdf is generated rather than committed (docs/TESTING.md:24), so an
    // empty stand-in stands in: what is under test is the filename selector, and
    // a viewer that fails to parse still owns the tab.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'markcopy-'));
    const uri = vscode.Uri.file(path.join(dir, 'blank.pdf'));
    fs.writeFileSync(uri.fsPath, '%PDF-1.4\n');

    await vscode.commands.executeCommand('vscode.open', uri);

    const open = customTabs();
    assert.ok(
      open.some((tab) => tab.viewType === PDF_VIEW && tab.uri === uri.toString()),
      `expected a ${PDF_VIEW} tab, saw: ${JSON.stringify(open)}`,
    );
  });

  test('.xlsm opens in the sheet preview too', async () => {
    // A macro-enabled workbook is the same OOXML package. It is a second entry
    // in the manifest's selector list, and a selector list is easy to shorten by
    // accident.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'markcopy-'));
    const uri = vscode.Uri.file(path.join(dir, 'macros.xlsm'));
    fs.copyFileSync(path.resolve(__dirname, '..', 'sample.xlsx'), uri.fsPath);

    await vscode.commands.executeCommand('vscode.open', uri);

    assert.ok(
      customTabs().some((tab) => tab.viewType === XLSX_VIEW),
      `expected a ${XLSX_VIEW} tab for .xlsm, saw: ${JSON.stringify(customTabs())}`,
    );
  });

  test('a file that is not a workbook still opens rather than failing to load', async () => {
    // docs/TESTING.md:90. The editor has to claim the tab and say what went
    // wrong; throwing during resolve leaves VS Code showing its own "cannot open"
    // error instead, and the reader never learns the file is not really a .xlsx.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'markcopy-'));
    const uri = vscode.Uri.file(path.join(dir, 'notreally.xlsx'));
    fs.writeFileSync(uri.fsPath, 'this is plain text\n');

    await vscode.commands.executeCommand('vscode.open', uri);

    assert.ok(
      customTabs().some((tab) => tab.viewType === XLSX_VIEW && tab.uri === uri.toString()),
      'expected the sheet preview to claim the tab and report the problem itself',
    );
  });

  test('a .stl file opens in the STL preview rather than as binary', async () => {
    // A one-triangle binary STL: 80-byte header, uint32 LE count, then 50 bytes
    // per triangle. Zeroed floats make a degenerate triangle, which is fine here
    // (the assertion is about which editor claimed the file, not the geometry).
    const stl = Buffer.alloc(84 + 50);
    stl.writeUInt32LE(1, 80);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'markcopy-'));
    const uri = vscode.Uri.file(path.join(dir, 'cube.stl'));
    fs.writeFileSync(uri.fsPath, stl);

    await vscode.commands.executeCommand('vscode.open', uri);

    const tab = await waitFor(() =>
      customTabs().find((candidate) => candidate.uri === uri.toString()),
    );
    assert.ok(
      tab,
      `expected a custom-editor tab for cube.stl, saw: ${JSON.stringify(customTabs())}`,
    );
    assert.strictEqual(tab.viewType, STL_VIEW, 'cube.stl opened in some other custom editor');
  });

  test('a .mov file opens in the video preview rather than as binary', async () => {
    // sample.mov is a real two-second H.264 clip, so this also proves the file
    // survives the round trip through a resource root outside the workspace.
    const uri = fixture('sample.mov');

    await vscode.commands.executeCommand('vscode.open', uri);

    const tab = await waitFor(() =>
      customTabs().find((candidate) => candidate.uri === uri.toString()),
    );
    assert.ok(
      tab,
      `expected a custom-editor tab for sample.mov, saw: ${JSON.stringify(customTabs())}`,
    );
    assert.strictEqual(tab.viewType, VIDEO_VIEW, 'sample.mov opened in some other custom editor');
  });

  test('.mp4 opens in the video preview, ahead of the built-in one', async () => {
    // VS Code ships its own video preview for *.{mp4,webm} at priority
    // "builtin", which "default" outranks. If MarkCopy's entry were ever
    // downgraded, this file would silently open in the built-in player instead
    // and every other test here would still pass.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'markcopy-'));
    const uri = vscode.Uri.file(path.join(dir, 'clip.mp4'));
    fs.copyFileSync(path.resolve(__dirname, '..', 'sample.mov'), uri.fsPath);

    await vscode.commands.executeCommand('vscode.open', uri);

    const tab = await waitFor(() =>
      customTabs().find((candidate) => candidate.uri === uri.toString()),
    );
    assert.strictEqual(tab?.viewType, VIDEO_VIEW, 'clip.mp4 did not open in the MarkCopy player');
  });

  test('a Markdown file opens as a MarkCopy tab when asked, and only when asked', async () => {
    const uri = fixture('sample.md');

    // "priority": "option" is the whole point of this pair: the editor picker
    // offers MarkCopy, and until someone picks it (or sets it as the default for
    // *.md), opening a Markdown file goes on landing in the text editor.
    await vscode.commands.executeCommand('vscode.open', uri);
    assert.ok(
      !customTabs().some((tab) => tab.uri === uri.toString()),
      `a plain open of sample.md should stay in the text editor, saw: ${JSON.stringify(customTabs())}`,
    );

    await closeEverything();
    await vscode.commands.executeCommand('vscode.openWith', uri, MARKDOWN_VIEW);

    const tab = await waitFor(() =>
      customTabs().find((candidate) => candidate.uri === uri.toString()),
    );
    assert.strictEqual(tab?.viewType, MARKDOWN_VIEW, 'sample.md did not open in the preview');
  });

  test('a CSV file opens as a MarkCopy tab when asked', async () => {
    const uri = fixture('sample.csv');

    await vscode.commands.executeCommand('vscode.openWith', uri, CSV_VIEW);

    const tab = await waitFor(() =>
      customTabs().find((candidate) => candidate.uri === uri.toString()),
    );
    assert.strictEqual(tab?.viewType, CSV_VIEW, 'sample.csv did not open in the preview');
  });

  test('opening a .tex leaves the source in the text editor and previews beside it', async () => {
    const uri = fixture('sample.tex');

    // Two things at once, and they pull in opposite directions. "option"
    // priority means the file itself must still land in the text editor, since a
    // .tex is a file people spend all day editing and stealing that would be
    // worse than having no preview at all. Auto-preview then opens the preview
    // as a SECOND tab beside it, the same bargain Markdown and CSV get. Being
    // the one MarkCopy format that opened to nothing is what made this look
    // broken in the first place, so it is worth pinning here rather than
    // trusting it to stay wired up.
    await vscode.commands.executeCommand('vscode.open', uri);

    const textTab = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .find(
        (tab) =>
          tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString(),
      );
    assert.ok(textTab, 'sample.tex should still open in a plain text editor');

    const preview = await waitFor(() =>
      customTabs().find((candidate) => candidate.uri === uri.toString()),
    );
    assert.strictEqual(preview?.viewType, TEX_VIEW, 'no LaTeX preview opened beside the source');
  });

  test('a burst of preview requests still opens exactly one panel', async () => {
    // The shape that actually broke: opening a folder restores its editors and
    // churns the active editor several times in a row, with no await between
    // passes. `vscode.openWith` is asynchronous, so every pass in that burst saw
    // "no panel yet" and started another open, and the window ended up carrying
    // a stack of pdf.js webviews for one document. Firing without awaiting is
    // the whole point of this test; awaiting between calls hides the bug.
    const uri = fixture('sample.tex');
    await vscode.workspace.openTextDocument(uri);

    for (let i = 0; i < 8; i++) {
      void vscode.commands.executeCommand('markcopy.openPreview', uri);
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const previews = customTabs().filter(
      (tab) => tab.uri === uri.toString() && tab.viewType === TEX_VIEW,
    );
    assert.strictEqual(
      previews.length,
      1,
      `a burst should collapse to one preview, saw ${previews.length}`,
    );
  });

  test('focusing a .tex over and over does not pile up preview panels', async () => {
    // The regression this exists for: auto-preview runs on every active-editor
    // change, and vscode.openWith targets ViewColumn.Beside, which is relative
    // to whatever is focused. Once focus is inside the preview's own group,
    // Beside means a new group, so each pass built ANOTHER panel. Every one of
    // them is a pdf.js webview with its own compile session, and they piled up
    // until the extension host fell over.
    const uri = fixture('sample.tex');
    const doc = await vscode.workspace.openTextDocument(uri);

    for (let pass = 0; pass < 5; pass++) {
      // Bounce focus between the source and the preview's group, which is the
      // shape that used to multiply panels.
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
      await waitFor(() => customTabs().find((c) => c.uri === uri.toString()));
      await vscode.commands.executeCommand('workbench.action.focusNextGroup');
    }
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const previews = customTabs().filter(
      (tab) => tab.uri === uri.toString() && tab.viewType === TEX_VIEW,
    );
    assert.strictEqual(
      previews.length,
      1,
      `expected exactly one LaTeX preview, saw ${previews.length}: ${JSON.stringify(customTabs())}`,
    );
  });

  test('a LaTeX file opens as a MarkCopy tab when asked for directly', async () => {
    const uri = fixture('sample.tex');

    await vscode.commands.executeCommand('vscode.openWith', uri, TEX_VIEW);

    const tab = await waitFor(() =>
      customTabs().find((candidate) => candidate.uri === uri.toString()),
    );
    assert.strictEqual(tab?.viewType, TEX_VIEW, 'sample.tex did not open in the preview');
  });

  test('the LaTeX preview has its own compile settings', () => {
    // As with the sheet limits below: read through the real configuration, since
    // a contributed key that does not match the key the code reads keeps
    // returning the hardcoded default and the setting silently does nothing.
    const cfg = vscode.workspace.getConfiguration('markcopy');
    assert.strictEqual(cfg.get('tex.compile'), 'auto');
    assert.strictEqual(cfg.get('tex.engine'), 'auto');
    assert.strictEqual(cfg.get('tex.recompileOnSave'), true);
    assert.strictEqual(cfg.get('tex.rootFile'), '');
  });

  test('the video preview has its own playback settings', () => {
    const cfg = vscode.workspace.getConfiguration('markcopy');
    assert.strictEqual(cfg.get('video.autoplay'), false);
    assert.strictEqual(cfg.get('video.loop'), false);
  });

  test('the sheet preview has its own row and column limits', () => {
    // Read through the real configuration rather than the source: a contributed
    // key that does not match the key the code reads keeps returning the
    // hardcoded default, and the setting silently does nothing.
    const cfg = vscode.workspace.getConfiguration('markcopy');
    assert.strictEqual(cfg.get('xlsx.maxRows'), 5000);
    assert.strictEqual(cfg.get('xlsx.maxColumns'), 200);
  });
});
