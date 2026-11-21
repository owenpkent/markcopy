import * as vscode from 'vscode';
import { openInDefaultApp, revealInOs } from './revealInOs';
import { getNonce } from './previewShell';
import { applyMarkcopySetting } from './settingsScope';
import { basename, saveFrame } from './videoEditor';
import { parseStlMessage } from './messages/stl';
import { isStlSetting } from './messages/settings';
import { MAX_STL_BYTES, checkStl } from './webview/stlInfo';
import { isModelFile, rankSiblings } from './stlSiblings';
import { glbHeaderProblem, stepHeaderProblem } from './webview/modelSniff';

// A read-only custom editor that renders STL, 3MF, GLB and STEP files with
// Three.js in a webview. Mouse-only orbit/pan/zoom; see media/stl.js (built from
// src/webview/stl.ts). A 3MF is a zip of XML parts, which the webview unpacks
// (src/webview/threeMf.ts), a GLB is read by glb.ts and a STEP file is
// tessellated by an Open CASCADE WebAssembly engine (step.ts): the host only
// stats each one and checks its first bytes.
//
// Its right-click menu carries a handful of copy actions (the current view as a
// PNG, the file name and path, the dimensions and triangle count) plus view
// presets and the theme. It deliberately skips the shared preview shell and
// builds its own HTML, but loads media/preview.css for the menu and toast styles.

// The allow-list lives with the message parsers; re-exported for the callers
// and tests that import it from here, as gifEditor.ts does.
export { isStlSetting };

export class StlEditorProvider implements vscode.CustomReadonlyEditorProvider {
  public static readonly viewType = 'markcopy.stlPreview';

  constructor(private readonly context: vscode.ExtensionContext) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => undefined };
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    panel: vscode.WebviewPanel,
  ): Promise<void> {
    const webview = panel.webview;
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot],
    };

    const nonce = getNonce();
    // Cache-bust the script so a rebuilt bundle always loads fresh: the webview
    // otherwise caches it by its (unchanged) resource URL.
    const asUri = (file: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, file)).with({ query: `v=${nonce}` });
    const theme = vscode.workspace
      .getConfiguration('markcopy', document.uri)
      .get<string>('theme', 'auto');
    // preview.css carries the shared context menu and toast styles.
    const stepEngineUri = asUri(STEP_ENGINE_FILE).toString();
    webview.html = this.html(webview, asUri('stl.js'), asUri('preview.css'), nonce, theme);

    // The models offered under Compare with, by the label the menu shows. The
    // webview asks for one by label and gets it only if it is in this map, so a
    // page cannot name a path of its own for the host to read.
    const siblings = new Map<string, vscode.Uri>();

    webview.onDidReceiveMessage(async (raw) => {
      const msg = parseStlMessage(raw);
      if (!msg) {
        return;
      }
      switch (msg.type) {
        case 'ready':
          await this.sendLoad(webview, document.uri, siblings, stepEngineUri);
          break;
        case 'compare': {
          const sibling = siblings.get(msg.name);
          if (sibling) {
            await this.sendCompare(webview, sibling, msg.name);
          }
          break;
        }
        case 'compareBrowse':
          await this.browseCompare(webview, document.uri);
          break;
        case 'revealInOS':
          revealInOs(document.uri);
          break;
        case 'saveFrame':
          await saveFrame(document.uri, msg.name, msg.data, webview);
          break;
        case 'openExternal':
          // Always the host's own document, never a URI the webview sent.
          await openInDefaultApp(document.uri);
          break;
        case 'updateSetting':
          await applyMarkcopySetting(msg.key, msg.value, document.uri);
          break;
      }
    });

    // Retint the viewport when markcopy.theme changes elsewhere (the Markdown or
    // PDF preview's Theme menu, or settings.json), matching src/pdfEditor.ts.
    const themeListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('markcopy.theme', document.uri)) {
        return;
      }
      const value = vscode.workspace
        .getConfiguration('markcopy', document.uri)
        .get<string>('theme', 'auto');
      void webview.postMessage({ type: 'setTheme', value });
    });
    panel.onDidDispose(() => themeListener.dispose());
  }

  private async sendLoad(
    webview: vscode.Webview,
    uri: vscode.Uri,
    siblings: Map<string, vscode.Uri>,
    stepEngineUri: string,
  ): Promise<void> {
    // The name and full path ride on every reply, errors included, so the menu's
    // Copy as > File Name and Full Path still work for a file that failed to load.
    const name = basename(uri);
    const path = uri.fsPath;
    try {
      const model = await readModel(uri);
      if ('error' in model) {
        void webview.postMessage({ type: 'error', name, path, message: model.error });
        return;
      }
      // The folder listing is a convenience for the Compare with menu; a folder
      // that cannot be listed (a virtual file system, a permission) just means
      // an empty menu with Browse in it.
      siblings.clear();
      for (const [label, sibling] of await findSiblings(uri).catch(() => [])) {
        siblings.set(label, sibling);
      }
      const cfg = vscode.workspace.getConfiguration('markcopy', uri);
      void webview.postMessage({
        type: 'load',
        format: model.format,
        name,
        path,
        bytes: model.bytes,
        showGrid: cfg.get<boolean>('stl.showGrid', true),
        meshColor: cfg.get<string>('stl.meshColor', '#8ab4f8'),
        upAxis: cfg.get<string>('stl.upAxis', 'z'),
        stepEngineUri,
        showBed: cfg.get<boolean>('stl.showBed', false),
        bedSize: cfg.get<string>('stl.bedSize', '256x256x256'),
        siblings: [...siblings.keys()],
      });
    } catch (err) {
      // Into the viewport as well as the toast: a blank 3D canvas with the
      // explanation in a notification that has already faded is how someone
      // concludes the preview is broken rather than the file.
      void webview.postMessage({
        type: 'error',
        name,
        path,
        message: `Could not read ${name} (${String(err)}).`,
      });
      void vscode.window.showErrorMessage(`MarkCopy: could not read ${name} (${String(err)}).`);
    }
  }

  // The second model of a comparison. It goes through exactly the checks the
  // first one did; a refusal is a toast, since the first model is still on
  // screen and should stay there.
  private async sendCompare(webview: vscode.Webview, uri: vscode.Uri, name: string): Promise<void> {
    try {
      const model = await readModel(uri);
      if ('error' in model) {
        void webview.postMessage({ type: 'toast', message: model.error });
        return;
      }
      void webview.postMessage({ type: 'compare', format: model.format, name, bytes: model.bytes });
    } catch (err) {
      void webview.postMessage({
        type: 'toast',
        message: `Could not read ${name} (${String(err)}).`,
      });
    }
  }

  private async browseCompare(webview: vscode.Webview, uri: vscode.Uri): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      defaultUri: vscode.Uri.joinPath(uri, '..'),
      filters: { '3D models': ['stl', '3mf', 'glb', 'step', 'stp'] },
      openLabel: 'Compare',
      title: `Compare ${basename(uri)} with`,
    });
    if (picked?.[0]) {
      await this.sendCompare(webview, picked[0], basename(picked[0]));
    }
  }

  private html(
    webview: vscode.Webview,
    scriptUri: vscode.Uri,
    styleUri: vscode.Uri,
    nonce: string,
    theme: string,
  ): string {
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      // The bundle is a single entry point with no code splitting, so a bare
      // nonce is enough here (no 'strict-dynamic', unlike src/previewShell.ts).
      // 'wasm-unsafe-eval' lets the STEP engine (Open CASCADE, WebAssembly)
      // compile; it allows WebAssembly only, not eval() or new Function(). No
      // other webview has it. See .github/SECURITY.md.
      `script-src 'nonce-${nonce}' 'wasm-unsafe-eval'`,
      // The one fetch the viewer makes: the gzipped STEP engine, from media/.
      `connect-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>MarkCopy 3D Preview</title>
<link href="${styleUri}" rel="stylesheet" />
<style>
  /* Viewport background per markcopy.theme; 'auto' follows the VS Code theme.
     The palette matches media/preview.css so a forced theme looks the same
     across the Markdown, PDF, and STL previews. src/webview/stl.ts reads the
     resolved value and hands it to the WebGL renderer as its clear color. */
  body { --mc-stl-bg: var(--vscode-editor-background); --mc-stl-fg: var(--vscode-editor-foreground); }
  body[data-mc-theme='light'] { --mc-stl-bg: #ffffff; --mc-stl-fg: #1f2328; }
  body[data-mc-theme='dark'] { --mc-stl-bg: #0d1117; --mc-stl-fg: #e6edf3; }
  body[data-mc-theme='green'] { --mc-stl-bg: #000000; --mc-stl-fg: #33ff33; }

  html, body { margin: 0; height: 100%; overflow: hidden; background: var(--mc-stl-bg); color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
  #viewport { position: fixed; inset: 0; }
  /* The section panel takes the right of the window and the 3D view the rest. */
  body.mc-section #viewport { right: 46%; }
  #viewport canvas { display: block; outline: none; }
  #toolbar { position: fixed; top: 8px; left: 8px; z-index: 10; display: flex; gap: 6px; }
  #toolbar button {
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    line-height: 1;
    border: 1px solid var(--vscode-contrastBorder, transparent);
    border-radius: 4px;
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #ffffff);
    cursor: pointer;
    padding: 0;
  }
  #toolbar button:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
  #toolbar button.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  #stats {
    position: fixed;
    bottom: 8px;
    left: 8px;
    z-index: 10;
    font-size: 11px;
    padding: 4px 7px;
    border-radius: 4px;
    color: var(--vscode-editor-foreground);
    background: var(--vscode-editorWidget-background, rgba(0, 0, 0, 0.4));
    border: 1px solid var(--vscode-widget-border, transparent);
    pointer-events: none;
    white-space: pre;
  }
  #stats .swatch, #section-readout .swatch {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 2px;
    margin-right: 5px;
  }
  .mc-stl-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
  }
  .mc-stl-bar button {
    min-width: 28px;
    height: 28px;
    padding: 0 6px;
    font-size: 13px;
    line-height: 1;
    border: 1px solid var(--vscode-contrastBorder, transparent);
    border-radius: 4px;
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #ffffff);
    cursor: pointer;
  }
  .mc-stl-bar button:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
  .mc-stl-bar button.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .mc-stl-bar input[type='range'] { flex: 1; min-width: 60px; }
  .mc-stl-bar input[type='number'] {
    width: 76px;
    height: 26px;
    box-sizing: border-box;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 3px;
  }
  #section {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: 46%;
    z-index: 5;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    background: var(--mc-stl-bg);
    color: var(--mc-stl-fg);
    border-left: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.4));
  }
  #section[hidden], #layers[hidden] { display: none; }
  #section .mc-stl-bar { padding: 8px; flex-wrap: wrap; }
  #section-canvas { flex: 1; min-height: 0; width: 100%; color: var(--mc-stl-fg); cursor: crosshair; }
  #section-readout { padding: 6px 10px 10px; font-size: 12px; min-height: 3.2em; font-variant-numeric: tabular-nums; }
  #section-readout .row { white-space: pre-wrap; }
  #section-readout .hint { opacity: 0.65; margin-top: 2px; }
  #layers {
    position: fixed;
    /* Bottom right, clear of the readout in the bottom left. */
    right: 8px;
    bottom: 8px;
    z-index: 10;
    width: min(560px, calc(100vw - 320px));
    min-width: 240px;
    box-sizing: border-box;
    padding: 5px 8px;
    border-radius: 4px;
    color: var(--vscode-editor-foreground);
    background: var(--vscode-editorWidget-background, rgba(0, 0, 0, 0.4));
    border: 1px solid var(--vscode-widget-border, transparent);
  }
  #layers label { display: flex; align-items: center; gap: 4px; white-space: nowrap; }
  #layer-label { white-space: nowrap; font-variant-numeric: tabular-nums; }
</style>
</head>
<body data-mc-theme="${theme}" data-vscode-context='{"preventDefaultContextMenuItems":true}'>
  <div id="viewport"></div>
  <div id="toolbar">
    <button id="btn-fit" title="Fit view" aria-label="Fit view">&#10530;</button>
    <button id="btn-wireframe" title="Toggle wireframe" aria-label="Toggle wireframe">&#9638;</button>
    <button id="btn-grid" title="Toggle grid" aria-label="Toggle grid">&#8862;</button>
    <button id="btn-section" title="Section: cut the model and measure it" aria-label="Toggle section">&#9707;</button>
  </div>
  <div id="stats"></div>
  <div id="layers" class="mc-stl-bar" hidden>
    <button id="layer-down" title="Previous layer" aria-label="Previous layer">&#8722;</button>
    <input id="layer-range" type="range" min="1" max="1" step="1" value="1" aria-label="Layer" />
    <button id="layer-up" title="Next layer" aria-label="Next layer">+</button>
    <span id="layer-label"></span>
    <label><input id="layer-only" type="checkbox" /> This layer only</label>
  </div>
  <div id="section" hidden>
    <div class="mc-stl-bar">
      <span>Cut</span>
      <button id="section-x" title="Cut across X" aria-label="Cut across X">X</button>
      <button id="section-y" title="Cut across Y" aria-label="Cut across Y">Y</button>
      <button id="section-z" title="Cut across Z" aria-label="Cut across Z">Z</button>
      <button id="section-down" title="Move the cut down" aria-label="Move the cut down">&#8722;</button>
      <input id="section-range" type="range" min="0" max="1" step="any" value="0" aria-label="Cut position" />
      <button id="section-up" title="Move the cut up" aria-label="Move the cut up">+</button>
      <input id="section-value" type="number" step="0.1" aria-label="Cut position" />
      <button id="section-close" title="Close the section" aria-label="Close the section">&#10005;</button>
    </div>
    <canvas id="section-canvas"></canvas>
    <div id="section-readout"></div>
  </div>
  <div id="mc-menu" class="mc-menu" role="menu" hidden></div>
  <div id="mc-toast" class="mc-toast" hidden></div>
  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

export type ModelFormat = 'stl' | '3mf' | 'glb' | 'step';

/** The gzipped STEP engine, copied into media/ by esbuild.web.js. */
const STEP_ENGINE_FILE = 'occt-import-js.wasm.gz';

type ReadModel = { format: ModelFormat; bytes: string } | { error: string };

const LABELS: Record<ModelFormat, string> = { stl: 'STL', '3mf': '3MF', glb: 'GLB', step: 'STEP' };

// One model off disk, checked and base64-encoded for the webview, or the reason
// it was refused. Throws only when the file cannot be read at all.
async function readModel(uri: vscode.Uri): Promise<ReadModel> {
  const name = basename(uri);
  const format = modelFormat(uri);
  const label = LABELS[format];
  // Size first, off stat, before a byte is read. Every guard used to live
  // in the webview, which meant a hostile file was read whole, base64'd
  // (1.33x, as a string), serialized through postMessage, and decoded on
  // the other side before anything asked whether it should have been
  // opened. The allocation the guards exist to prevent had already
  // happened five times over by then, in the extension host, where it
  // takes the whole window down rather than one preview.
  const stat = await vscode.workspace.fs.stat(uri);
  if (stat.size > MAX_STL_BYTES) {
    return {
      error: `${name} is ${mib(stat.size)}, above MarkCopy's ${mib(MAX_STL_BYTES)} limit for ${label} previews.`,
    };
  }

  const bytes = await vscode.workspace.fs.readFile(uri);

  // Cheap to run here and it saves base64-encoding a file that is about to
  // be refused. The webview checks again on arrival: this one is about not
  // doing pointless work, that one is the actual guard on the allocation.
  //
  // A 3MF is unpacked in the webview, behind the zip limits in
  // src/ooxml/zip.ts; all that is worth checking here is that it is a zip.
  if (format === '3mf') {
    if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) {
      return { error: `${name} is not a 3MF package (it is not a zip archive).` };
    }
  } else if (format === 'glb') {
    // The JSON chunk, the compression and the triangle count are read in the
    // webview (src/webview/glb.ts); here only the 12-byte header.
    const problem = glbHeaderProblem(bytes);
    if (problem) {
      return { error: `${name} is not a GLB file: ${problem}` };
    }
  } else if (format === 'step') {
    const problem = stepHeaderProblem(bytes);
    if (problem) {
      return { error: `${name} is not a STEP file: ${problem}` };
    }
  } else {
    const check = checkStl(bytes);
    if (!check.ok) {
      return { error: check.reason ?? `Could not load ${name}.` };
    }
  }
  return {
    format,
    // Base64, not the raw Uint8Array. The webview transport JSON-encodes
    // messages, and JSON turns a typed array into a numeric-keyed object
    // ~13x the size of the file (a 5 MB STL becomes ~67 MB of JSON and
    // several hundred MB of objects). Base64 costs 1.33x and stays a
    // string end to end. toBytes() in src/webview/stlInfo.ts decodes it.
    bytes: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64'),
  };
}

// How many entries of one folder are looked at for the Compare with menu. A
// folder of ten thousand scans is not worth listing in full for a twelve-line
// menu.
const MAX_SIBLING_ENTRIES = 2000;

// The other models near `uri`, as [label, uri] pairs in menu order: the same
// folder, its `versions` subfolder, and the parent when the file is itself in a
// `versions` folder. That is the layout a model kept with its history has
// (current file on top, older ones in versions/), from either side.
async function findSiblings(uri: vscode.Uri): Promise<Array<[string, vscode.Uri]>> {
  const dir = vscode.Uri.joinPath(uri, '..');
  const own = basename(uri);
  const found = new Map<string, vscode.Uri>();
  const list = async (folder: vscode.Uri, prefix: string): Promise<void> => {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(folder);
    } catch {
      return; // No such folder, which is the usual case for versions/.
    }
    for (const [entry, type] of entries.slice(0, MAX_SIBLING_ENTRIES)) {
      const isFile = (type & vscode.FileType.File) !== 0;
      if (isFile && isModelFile(entry) && !(prefix === '' && entry === own)) {
        found.set(prefix + entry, vscode.Uri.joinPath(folder, entry));
      }
    }
  };
  await list(dir, '');
  await list(vscode.Uri.joinPath(dir, 'versions'), 'versions/');
  if (basename(dir).toLowerCase() === 'versions') {
    await list(vscode.Uri.joinPath(dir, '..'), '../');
  }
  return rankSiblings(own, [...found.keys()]).map((label) => [
    label,
    found.get(label) as vscode.Uri,
  ]);
}

/** Which model format the document is, by its extension; anything else is STL. */
export function modelFormat(uri: vscode.Uri): ModelFormat {
  const path = uri.path.toLowerCase();
  if (path.endsWith('.3mf')) {
    return '3mf';
  }
  if (path.endsWith('.glb')) {
    return 'glb';
  }
  return path.endsWith('.step') || path.endsWith('.stp') ? 'step' : 'stl';
}

/** Whether the document is a 3MF package rather than an STL, by its extension. */
export function is3mf(uri: vscode.Uri): boolean {
  return uri.path.toLowerCase().endsWith('.3mf');
}

function mib(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MiB`;
}
