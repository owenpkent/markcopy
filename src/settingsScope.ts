import * as vscode from 'vscode';

// Resolve which scope to persist a `markcopy` setting to: the narrowest scope
// that already defines it (folder, then workspace), else Global (User). Writing
// at the scope where the value is defined keeps a workspace (or folder) override
// from being silently shadowed by a Global write, which would make an in-preview
// menu appear to do nothing. Detecting a folder-level override requires the
// config to be resource-scoped, so pass a `scopeUri` when one is available.
export function settingTarget(
  config: vscode.WorkspaceConfiguration,
  key: string,
): vscode.ConfigurationTarget {
  const info = config.inspect(key);
  if (info?.workspaceFolderValue !== undefined) {
    return vscode.ConfigurationTarget.WorkspaceFolder;
  }
  if (info?.workspaceValue !== undefined) {
    return vscode.ConfigurationTarget.Workspace;
  }
  return vscode.ConfigurationTarget.Global;
}

// Persist a `markcopy` setting changed from an in-preview menu at the scope where
// it is defined (see settingTarget). `scopeUri` selects the folder whose override
// is considered, so a per-folder value is respected and updated in place.
export function applyMarkcopySetting(
  key: string,
  value: unknown,
  scopeUri?: vscode.Uri,
): Thenable<void> {
  const config = vscode.workspace.getConfiguration('markcopy', scopeUri);
  return config.update(key, value, settingTarget(config, key));
}
