// Reading a Windows executable's metadata into the preview's HTML.
//
// Free of the `vscode` module, like src/xlsx and src/docx/read, so the parser
// and the markup both unit-test and fuzz directly.
export {
  readPe,
  bytesSource,
  PeError,
  type ByteSource,
  type PeInfo,
  type PeSection,
  type PeImport,
  type PeExports,
  type PeSignature,
} from './read';
export { type PeRich, type PeRichEntry } from './rich';
export { readSigner, type Signer } from './signer';
export { iconToPng, pickIcon, encodePng, type PeIcon } from './icon';
export { readVersionResource, type VersionInfo } from './version';
export { renderPeHtml, ICON_MEDIA_ID, type RenderOptions } from './render';
export { formatBytes } from '../binary/html';
