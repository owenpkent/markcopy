// occt-import-js ships no type declarations. This is the part MarkCopy uses.
declare module 'occt-import-js' {
  interface OcctModuleOptions {
    // The compiled engine itself. Given, the glue never fetches anything.
    wasmBinary?: ArrayBuffer | Uint8Array;
  }
  const factory: (options?: OcctModuleOptions) => Promise<unknown>;
  export default factory;
}
