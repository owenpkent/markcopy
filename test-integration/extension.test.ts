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
  });

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

  test('auto-opens a preview when an on-disk Markdown file is focused', async () => {
    // Auto-preview only fires for real files on disk (scheme 'file'), so write a
    // temp file rather than using an untitled document.
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'markcopy-')), 'auto.md');
    fs.writeFileSync(file, '# Auto\n\nOpened by focus, no command needed.\n');

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(doc);
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const labels = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .map((tab) => tab.label);
    assert.ok(
      labels.some((label) => label === 'Preview auto.md'),
      `expected an auto-opened preview for auto.md, saw: ${JSON.stringify(labels)}`,
    );
  });

  test('auto-opens a preview when an on-disk CSV file is focused', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'markcopy-')), 'sales.csv');
    fs.writeFileSync(file, 'region,units\n"North, America",1284\nEMEA,976\n');

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(doc);
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const labels = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .map((tab) => tab.label);
    assert.ok(
      labels.some((label) => label === 'Preview sales.csv'),
      `expected an auto-opened preview for sales.csv, saw: ${JSON.stringify(labels)}`,
    );
  });
});
