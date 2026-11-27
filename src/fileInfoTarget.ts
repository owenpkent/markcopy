// Which file a file-information command acts on. Kept free of the `vscode`
// module so a test can run it. The explorer and editor-title menus pass the
// file as the first argument; the Command Palette passes nothing, and then the
// file open in the active editor is used.
export function resolveFileTarget<T>(
  explicit: T | undefined,
  activeResource: T | undefined,
): T | undefined {
  return explicit ?? activeResource;
}
