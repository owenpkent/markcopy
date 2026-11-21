// Stands in for the Node built-ins (fs, path, crypto) that occt-import-js's
// Emscripten glue requires on its Node-only code paths. A webview is never Node,
// so those paths do not run; the bundle only needs the names to resolve.
export default {};
