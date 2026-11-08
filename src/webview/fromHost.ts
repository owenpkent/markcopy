// Only the extension host talks to a MarkCopy webview. VS Code delivers its
// messages from the webview's outer frame, which is the parent of the frame the
// page runs in and shares its origin (the inner document is written into a
// blank frame, so it inherits the origin). Either test identifies that sender;
// a message from anywhere else is ignored before its payload is read.
export function fromHost(event: MessageEvent): boolean {
  return event.origin === window.origin || event.source === window.parent;
}
