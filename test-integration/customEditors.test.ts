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

  test('the sheet preview has its own row and column limits', () => {
    // Read through the real configuration rather than the source: a contributed
    // key that does not match the key the code reads keeps returning the
    // hardcoded default, and the setting silently does nothing.
    const cfg = vscode.workspace.getConfiguration('markcopy');
    assert.strictEqual(cfg.get('xlsx.maxRows'), 5000);
    assert.strictEqual(cfg.get('xlsx.maxColumns'), 200);
  });
});
