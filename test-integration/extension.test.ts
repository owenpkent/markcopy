import * as assert from 'assert';
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
  });

  test('has the expected configuration defaults', () => {
    const cfg = vscode.workspace.getConfiguration('markcopy');
    assert.strictEqual(cfg.get('styleProfile'), 'github');
    assert.strictEqual(cfg.get('syncScroll'), true);
    assert.strictEqual(cfg.get('theme'), 'auto');
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
});
