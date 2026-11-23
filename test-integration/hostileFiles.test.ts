// Hostile files, in a real VS Code.
//
// The file-information previews read untrusted packages in the extension host,
// a process the reader's other extensions share. An audit on 2026-11-23 found
// files of a few hundred bytes that took that process past 4 GB and aborted it.
// The unit tests now pin each case, but they run the readers in a test worker.
// This runs three of them where the damage would actually be done: these
// tests execute inside the extension host, so process.memoryUsage() here is
// the host's own memory, a host that dies takes the run with it, and a host
// that stalls shows up as a timer that fires late.
//
// The files are the audit's own, embedded so nothing binary is checked in.
// They are inert: malformed metadata, with no code in them to run.
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const PACKAGE_VIEW = 'markcopy.packagePreview';

// A Debian package (250 bytes) whose control archive is nine skippable
// Zstandard frames and then a frame declaring a 1.9 GiB window. The check once
// looked only at the first frame: 1.97 GB allocated, 10.9 s.
const ZSTD_WINDOW_DEB = [
  'ITxhcmNoPgpkZWJpYW4tYmluYXJ5ICAgMCAgICAgICAgICAgMCAgICAgMCAgICAgMTAwNjQ0ICA0ICAgICAgICAg',
  'YAoyLjAKY29udHJvbC50YXIuenN0IDAgICAgICAgICAgIDAgICAgIDAgICAgIDEwMDY0NCAgMTE4ICAgICAgIGAK',
  'UCpNGAAAAABQKk0YAAAAAFAqTRgAAAAAUCpNGAAAAABQKk0YAAAAAFAqTRgAAAAAUCpNGAAAAABQKk0YAAAAAFAq',
  'TRgAAAAAKLUv/QCnAgAQAAIAEAACABAAAgAQAAIAEAACABAAAgAQAAIAEAACABAAAwAQAA==',
].join('');

// An Android package (642 bytes) whose manifest string pool declares 100,000
// strings, every one pointing at the same 16 KB string. Aborted at 4.2 GB.
const STRING_POOL_APK = [
  'UEsDBBQAAAAIALJVd11jBX/z+gEAAPBaBgATAAAAQW5kcm9pZE1hbmlmZXN0LnhtbO3coQ0CURAE0P1cuHyJQBCC',
  'pBDqwJ2ABAEGaqAKBAVQBCXRAWwudw5LMO+NmBVTwzZR47Vto8QqHtn3a4le1m3Zxmi6CQAAAAAAAAAAAAAAAAAA',
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPipZ6YDAAAAAAAAAAAAAAAAAAAA/i5q',
  'PXanw353vsSkzGI9/AZ4D0re88yoyc3iy+YDUEsBAhQAFAAAAAgAslV3XWMFf/P6AQAA8FoGABMAAAAAAAAAAAAA',
  'AIABAAAAAEFuZHJvaWRNYW5pZmVzdC54bWxQSwUGAAAAAAEAAQBBAAAAKwIAAAAA',
].join('');

// A macOS installer package (1.3 KB) with one directory named with a megabyte
// of text and a thousand children, so every child's path was a megabyte.
// 1.6 GB of heap and a 210 MB page.
const LONG_PATH_PKG = [
  'eGFyIQAcAAEAAAAAAAAE8QAAAAAAEKwmAAAAAHja7co9CoNAEIDRI3mBYSsvspgVBH/CsoXePsZgkTqke6+YYZgv',
  '9lxTtG1IMU5zSbHmpaQeAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOBH0a15KSna8SzpMdUytK0e0V13jNN8zqvI',
  'X+X7cUfdp9JqtVqtVqvVarVarVar1Wq1Wq1Wq9VqtVqtVqvVarVarVar1Wq1Wq1Wq9VqtVqtVqvVarVarVar1Wq1',
  'Wq1Wq9VqtVqtVqvVarVarVar1Wq1Wq1Wq9VqtVqtVqvVarVarVar1Wq1Wq1Wq9VqtVqtVqvVarVarVar1Wq1Wq1W',
  'q9VqtVqtVqvVarVarVar1Wq1Wq1Wq9Vq/93eq23DOfdc0wv3xKlx',
].join('');

const MB = 1024 * 1024;
// Far above what a bounded reader needs (a few megabytes) and far below what
// any of these files cost before the fixes (gigabytes), so the assertion is not
// sensitive to what else the host happens to allocate while a test runs.
const MAX_HEAP_GROWTH = 256 * MB;
const MAX_RSS_GROWTH = 768 * MB;
// A timer set for 50 ms that fires this late means the host was blocked.
const MAX_STALL_MS = 3000;

function customTabs(): { viewType: string; uri: string }[] {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .map((tab) => tab.input)
    .filter((input): input is vscode.TabInputCustom => input instanceof vscode.TabInputCustom)
    .map((input) => ({ viewType: input.viewType, uri: input.uri.toString() }));
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Cost {
  heapGrowth: number;
  rssGrowth: number;
  worstStall: number;
}

/**
 * Run `work`, then keep watching the host for `watchMs`: the preview reads
 * the file after its webview loads, which is after the tab appears, so the
 * cost arrives a moment after `work` returns.
 */
async function measure(work: () => Promise<void>, watchMs: number): Promise<Cost> {
  const before = process.memoryUsage();
  const heapOf = (m: NodeJS.MemoryUsage): number => m.heapUsed + m.arrayBuffers;
  let peakHeap = heapOf(before);
  let peakRss = before.rss;
  let worstStall = 0;
  const sample = async (): Promise<void> => {
    const started = Date.now();
    await sleep(50);
    worstStall = Math.max(worstStall, Date.now() - started - 50);
    const now = process.memoryUsage();
    peakHeap = Math.max(peakHeap, heapOf(now));
    peakRss = Math.max(peakRss, now.rss);
  };
  await work();
  const until = Date.now() + watchMs;
  while (Date.now() < until) {
    await sample();
  }
  return {
    heapGrowth: peakHeap - heapOf(before),
    rssGrowth: peakRss - before.rss,
    worstStall,
  };
}

function assertCheap(cost: Cost, what: string): void {
  const text = `${what}: heap +${Math.round(cost.heapGrowth / MB)} MB, rss +${Math.round(cost.rssGrowth / MB)} MB, worst stall ${cost.worstStall} ms`;
  console.log(text);
  assert.ok(cost.heapGrowth < MAX_HEAP_GROWTH, `the extension host's heap grew too far. ${text}`);
  assert.ok(cost.rssGrowth < MAX_RSS_GROWTH, `the extension host's memory grew too far. ${text}`);
  assert.ok(cost.worstStall < MAX_STALL_MS, `the extension host stopped responding. ${text}`);
}

async function openInPreview(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand('vscode.open', uri);
  const deadline = Date.now() + 10000;
  while (!customTabs().some((tab) => tab.uri === uri.toString())) {
    assert.ok(Date.now() < deadline, `no custom editor tab opened for ${uri.fsPath}`);
    await sleep(50);
  }
  const tab = customTabs().find((t) => t.uri === uri.toString());
  assert.strictEqual(tab?.viewType, PACKAGE_VIEW, `${uri.fsPath} opened in some other editor`);
}

suite('hostile files in the package preview', () => {
  let dir: string;

  suiteSetup(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'markcopy-hostile-'));
    // Wake the extension and let the window settle, so its start-up
    // allocations are not counted against the first file.
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await sleep(1500);
  });

  teardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  const cases: [name: string, file: string, base64: string][] = [
    ['a Zstandard frame declaring a 1.9 GiB window', 'window.deb', ZSTD_WINDOW_DEB],
    ['an Android string pool naming one string 100,000 times', 'pool.apk', STRING_POOL_APK],
    ['a macOS installer whose directory name is a megabyte long', 'path.pkg', LONG_PATH_PKG],
  ];

  for (const [name, file, base64] of cases) {
    test(`previewing ${name} costs the extension host almost nothing`, async () => {
      const uri = vscode.Uri.file(path.join(dir, file));
      fs.writeFileSync(uri.fsPath, Buffer.from(base64, 'base64'));
      const cost = await measure(() => openInPreview(uri), 4000);
      assertCheap(cost, file);
      // Still alive and answering: a command round-trips through the host.
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      assert.deepStrictEqual(customTabs(), []);
    });
  }

  // A file that changes on disk redraws its preview. Each change event once
  // started a read of its own, so a file rewritten in a loop (a build output
  // with its info page open) stacked up as many reads, each hashing the whole
  // file, as there were events.
  test('a file rewritten many times while its preview is open is read one at a time', async () => {
    // A minimal 64-bit ELF header with no program or section headers, then
    // 4 MB of padding for the hash to work through.
    const header = Buffer.alloc(64);
    header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
    header.writeUInt16LE(3, 16); // e_type: shared object
    header.writeUInt16LE(62, 18); // e_machine: x86-64
    header.writeUInt32LE(1, 20); // e_version
    header.writeUInt16LE(64, 52); // e_ehsize
    header.writeUInt16LE(56, 54); // e_phentsize
    header.writeUInt16LE(64, 58); // e_shentsize
    const body = Buffer.concat([header, Buffer.alloc(4 * MB, 0x41)]);
    const uri = vscode.Uri.file(path.join(dir, 'rebuilt.elf'));
    fs.writeFileSync(uri.fsPath, body);

    const cost = await measure(async () => {
      await openInPreview(uri);
      for (let i = 0; i < 60; i++) {
        body.writeUInt32LE(i, body.length - 4);
        fs.writeFileSync(uri.fsPath, body);
        await sleep(15);
      }
    }, 4000);
    assertCheap(cost, 'rebuilt.elf, rewritten 60 times');
  });
});
