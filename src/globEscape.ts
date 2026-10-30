// The second argument of a RelativePattern is a glob, so a file name is only an
// exact match when its glob metacharacters are escaped: a watcher on
// `photo[1].png` otherwise matches `photo1.png` and never the file itself.
// VS Code's documented escape is to wrap the character in brackets.
export function escapeGlobName(name: string): string {
  return name.replace(/[[\]{}*?]/g, (c) => `[${c}]`);
}
