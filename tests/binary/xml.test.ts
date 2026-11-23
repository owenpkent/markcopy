// @vitest-environment node
//
// A tree of XML costs far more than its text: an empty element is three bytes
// in and some hundreds of bytes of objects out. A 16 KB installer package whose
// table of contents inflated to 16 MiB of `<a/>` built a tree of over a
// gigabyte. parseXmlBounded is the same walk as parseXml with a budget.
import { describe, expect, it } from 'vitest';
import { ReadError } from '../../src/binary/reader';
import { parseXmlBounded } from '../../src/binary/xml';
import { child, findAll, parseXml } from '../../src/ooxml/xnode';

describe('parseXmlBounded', () => {
  it('builds the same tree parseXml does', () => {
    const xml =
      '<?xml version="1.0"?><a:root xmlns:a="urn:x" id="1"><!-- c --><item n="x">one</item><item>two<b/></item></a:root>';
    expect(parseXmlBounded(xml)).toEqual(parseXml(xml));
    const root = child(parseXmlBounded(xml), 'root');
    expect(root?.attrs.id).toBe('1');
    expect(findAll(root!, 'item').map((n) => n.text)).toEqual(['one', 'two']);
  });

  it('refuses a document with more elements than the limit, and accepts one at it', () => {
    const many = (count: number): string => `<r>${'<a/>'.repeat(count - 1)}</r>`;
    expect(() => parseXmlBounded(many(50), { maxNodes: 50 })).not.toThrow();
    expect(() => parseXmlBounded(many(51), { maxNodes: 50 })).toThrow(ReadError);
  });

  it('refuses nesting deeper than the limit, and accepts nesting at it', () => {
    const nested = (depth: number): string => `${'<a>'.repeat(depth)}${'</a>'.repeat(depth)}`;
    expect(() => parseXmlBounded(nested(10), { maxDepth: 10 })).not.toThrow();
    expect(() => parseXmlBounded(nested(11), { maxDepth: 10 })).toThrow(ReadError);
  });

  it('refuses an oversized document before parsing any of it', () => {
    expect(() => parseXmlBounded(`<r>${'x'.repeat(100)}</r>`, { maxChars: 50 })).toThrow(ReadError);
  });

  it('stops a megabyte of empty elements at the default limit without building the tree', () => {
    // 350,000 elements: about 100 MB of tree if it were built.
    const bomb = `<r>${'<a/>'.repeat(350_000)}</r>`;
    const before = process.memoryUsage().heapUsed;
    expect(() => parseXmlBounded(bomb)).toThrow(/more elements/);
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(64 * 1024 * 1024);
  });

  it('keeps a recursive walk safe: default depth is far inside the stack', () => {
    const deep = `${'<a>'.repeat(5000)}${'</a>'.repeat(5000)}`;
    expect(() => parseXmlBounded(deep)).toThrow(/nested/);
    const allowed = `${'<a>'.repeat(120)}<leaf/>${'</a>'.repeat(120)}`;
    expect(findAll(parseXmlBounded(allowed), 'leaf')).toHaveLength(1);
  });

  it('lets malformed XML fail as the underlying parser fails it', () => {
    expect(() => parseXmlBounded('<a><b></a>')).toThrow();
  });
});
