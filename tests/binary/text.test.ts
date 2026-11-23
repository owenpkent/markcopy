// @vitest-environment node
//
// printable() cleans every string the file-information previews show, so what
// it costs is multiplied by every string in every table. It once appended a
// character at a time, which the engine keeps as a chain of nodes of about 32
// bytes each until something flattens it: a file that named one 16 KB string
// from 100,000 table entries reached 4 GB and took the extension host down.
// The node environment is for process.memoryUsage().
import { describe, expect, it } from 'vitest';
import { clip, printable } from '../../src/binary/text';

const RLO = String.fromCharCode(0x202e);
const NUL = String.fromCharCode(0);
const LINE_SEPARATOR = String.fromCharCode(0x2028);

describe('printable', () => {
  it('returns a clean string as the same string, not a copy', () => {
    const text = 'Contoso Tool 1.2.3';
    expect(printable(text)).toBe(text);
    expect(printable('')).toBe('');
  });

  it('drops controls, separators and direction overrides wherever they sit', () => {
    expect(printable(`${NUL}ab${RLO}cd${LINE_SEPARATOR}`)).toBe('abcd');
    expect(printable(`ab${String.fromCharCode(7)}`)).toBe('ab');
    expect(printable(`${RLO}${RLO}`)).toBe('');
    expect(printable(`x${String.fromCharCode(0x2066)}y${String.fromCharCode(0x9f)}z`)).toBe('xyz');
  });

  it('keeps tabs and line feeds only when asked', () => {
    expect(printable('a\tb\nc')).toBe('abc');
    expect(printable('a\tb\nc', true)).toBe('a\tb\nc');
    expect(printable('a\r\nb', true)).toBe('a\nb');
  });

  it('keeps characters outside the basic plane whole', () => {
    const text = `caf${String.fromCharCode(0xe9)} ${String.fromCodePoint(0x1f600)}${RLO}!`;
    expect(printable(text)).toBe(
      `caf${String.fromCharCode(0xe9)} ${String.fromCodePoint(0x1f600)}!`,
    );
  });

  it('cleans a string longer than one chunk without losing or reordering any of it', () => {
    // Longer than the 8192 units converted at a time, dirty at both ends and
    // across a chunk boundary.
    const body = Array.from({ length: 30000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join(
      '',
    );
    const dirty = `${RLO}${body.slice(0, 8191)}${NUL}${body.slice(8191)}${RLO}`;
    expect(printable(dirty)).toBe(body);
  });

  it('costs about the size of the string, not thirty times it', () => {
    // 2,000 dirty strings of 16 KB: 32 MB of characters, 64 MB as flat strings.
    // Appending a character at a time kept about 1 GB for the same input.
    const dirty = `${RLO}${'a'.repeat(16000)}`;
    const before = process.memoryUsage().heapUsed;
    const kept: string[] = [];
    for (let i = 0; i < 2000; i++) {
      kept.push(printable(dirty));
    }
    const grown = process.memoryUsage().heapUsed - before;
    expect(kept).toHaveLength(2000);
    expect(kept[1999]).toHaveLength(16000);
    expect(grown).toBeLessThan(200 * 1024 * 1024);
  });
});

describe('clip', () => {
  it('leaves a string that fits alone', () => {
    expect(clip('abc', 3)).toBe('abc');
    expect(clip('', 0)).toBe('');
  });

  it('cuts a longer one to the limit, ending in an ellipsis', () => {
    const cut = clip('abcdefgh', 5);
    expect(cut).toHaveLength(5);
    expect(cut).toBe(`abcd${String.fromCharCode(0x2026)}`);
  });

  it('never returns more than the limit, even a tiny one', () => {
    expect(clip('abcdef', 1)).toHaveLength(1);
    expect(clip('abcdef', 0).length).toBeLessThanOrEqual(1);
  });
});
