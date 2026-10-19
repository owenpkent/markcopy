import * as vscode from 'vscode';

// Show a document in the OS file manager, as the editor tab's own "Reveal in
// File Explorer" does. The webview only asks; the URI is always the host's own
// document, never anything the webview sent. A document that is not a file on
// disk (untitled, a remote or virtual file system) has no folder to open.
export function revealInOs(uri: vscode.Uri): void {
  if (uri.scheme === 'file') {
    void vscode.commands.executeCommand('revealFileInOS', uri);
  } else {
    vscode.window.setStatusBarMessage(
      'MarkCopy: This file is not on disk, so there is no folder to open.',
      2500,
    );
  }
}
