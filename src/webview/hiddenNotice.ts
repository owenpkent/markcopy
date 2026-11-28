// The notice above a Markdown or CSV preview that says the file holds invisible
// characters (src/hiddenText.ts does the finding, on the host).
//
// A sibling of #content, never inside it: a copy action reads #content, and the
// sanitizer only ever sees the rendered document. Everything from the file, the
// decoded text above all, goes in through textContent. Nothing here is HTML.
import type { HiddenKind, HiddenRun, HiddenScan } from '../hiddenText';

export interface HiddenNoticeHost {
  /** Send a message to the extension host. */
  post(message: unknown): void;
}

const KIND_NOUN: Record<HiddenKind, [string, string]> = {
  tag: ['tag character', 'tag characters'],
  selector: ['variation selector', 'variation selectors'],
  bidi: ['text direction control', 'text direction controls'],
  zeroWidth: ['zero-width character', 'zero-width characters'],
  filler: ['Hangul filler', 'Hangul fillers'],
};

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

function isRun(value: unknown): value is HiddenRun {
  const run = value as HiddenRun | undefined;
  return (
    !!run &&
    Number.isSafeInteger(run.line) &&
    Number.isSafeInteger(run.column) &&
    Number.isSafeInteger(run.count) &&
    Array.isArray(run.kinds) &&
    Array.isArray(run.codePoints)
  );
}

/**
 * "5 zero-width characters (U+200B, U+200C)" for the run. A run that decodes
 * leaves the code points out: the text it spells, shown under it, says more
 * than a list of them.
 */
export function describeRun(run: HiddenRun): string {
  const kinds = run.kinds.filter((k) => k in KIND_NOUN);
  const nouns =
    kinds.length === 1
      ? plural(run.count, KIND_NOUN[kinds[0]][0], KIND_NOUN[kinds[0]][1])
      : `${plural(run.count, 'invisible character', 'invisible characters')}`;
  const mixed = kinds.length > 1 ? ` (${kinds.map((k) => KIND_NOUN[k][1]).join(', ')})` : '';
  if (typeof run.decoded === 'string') {
    return `${run.count} ${nouns}${mixed}`;
  }
  const labels = run.codePoints.filter((c) => typeof c === 'string').join(', ');
  const more = run.codePointsTruncated ? ', ...' : '';
  return `${run.count} ${nouns}${mixed} (${labels}${more})`;
}

/** "This file has 3 runs of invisible characters (412 characters). 1 spells out hidden text." */
export function headline(scan: HiddenScan): string {
  const decoded = scan.runs.filter((r) => typeof r.decoded === 'string').length;
  const partial = scan.runs.length < scan.totalRuns;
  let text =
    `This file has ${scan.totalRuns} ${plural(scan.totalRuns, 'run', 'runs')} of invisible ` +
    `characters (${scan.totalChars} ${plural(scan.totalChars, 'character', 'characters')}).`;
  if (decoded > 0) {
    text += ` ${partial ? 'At least ' : ''}${decoded} ${plural(decoded, 'spells', 'spell')} out hidden text.`;
  }
  return `${text} Copies include them.`;
}

export interface HiddenNotice {
  /** Show, update or hide the notice for a render. `scan` is what the host sent. */
  update(scan: unknown, docKey: string, docVersion: number): void;
}

export function createHiddenNotice(anchor: HTMLElement, host: HiddenNoticeHost): HiddenNotice {
  const bar = document.createElement('aside');
  // No id: a Markdown heading's slug could equal it, and a fragment link would
  // then resolve to the notice, not the heading.
  bar.className = 'mc-hidden-text';
  bar.hidden = true;
  anchor.before(bar);
  // A CSV grid fills the window's height, so it needs to know what sits above it.
  // Always a length with its unit: `calc(100vh - px)` would be invalid and the
  // grid would lose its height, not fall back to the var() default.
  const publishHeight = (): void => {
    const height = bar.hidden ? 0 : Math.ceil(bar.getBoundingClientRect().height);
    document.body.style.setProperty('--mc-hidden-h', `${height}px`);
  };
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(publishHeight).observe(bar);
  }

  // The flagged set the user dismissed. A different set shows the bar again.
  let dismissed: string | undefined;
  let detailsOpen = false;

  const button = (label: string, onClick: () => void, className?: string): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (className) {
      b.className = className;
    }
    b.addEventListener('click', onClick);
    return b;
  };

  return {
    update(raw: unknown, docKey: string, docVersion: number): void {
      const scan = raw as HiddenScan | undefined;
      if (
        !scan ||
        !Number.isSafeInteger(scan.totalRuns) ||
        scan.totalRuns <= 0 ||
        !Number.isSafeInteger(scan.totalChars) ||
        !Array.isArray(scan.runs)
      ) {
        // A clean file ends any dismissal: the set changed.
        dismissed = undefined;
        bar.hidden = true;
        bar.replaceChildren();
        publishHeight();
        return;
      }
      // The fingerprint covers every flagged character, listed or not, so a
      // different payload of the same size still shows the bar again.
      const fingerprint = typeof scan.fingerprint === 'string' ? scan.fingerprint : '';
      const key = `${docKey}|${fingerprint}|${scan.totalRuns}|${scan.totalChars}`;
      if (dismissed === key) {
        bar.hidden = true;
        publishHeight();
        return;
      }
      // A redraw replaces every control; remember which one had the focus.
      const focused = document.activeElement;
      const focusId =
        focused instanceof HTMLElement && bar.contains(focused) ? focused.dataset.focus : undefined;
      const old = bar.querySelector('details');
      if (old) {
        detailsOpen = old.open;
      }
      // The list scrolls inside the notice. Rebuilding it would reset it to the
      // top and leave the focused link far out of view, so put the offset back.
      const listScroll = bar.querySelector('.mc-hidden-list')?.scrollTop ?? 0;
      const runs = scan.runs.filter(isRun);

      bar.hidden = false;
      bar.setAttribute('role', 'status');
      bar.classList.toggle('mc-hidden-warn', Boolean(scan.encoded));
      bar.classList.toggle('mc-hidden-info', !scan.encoded);

      const top = document.createElement('div');
      top.className = 'mc-hidden-top';
      const message = document.createElement('span');
      message.className = 'mc-hidden-message';
      message.textContent = headline({ ...scan, runs });
      const actions = document.createElement('span');
      actions.className = 'mc-hidden-actions';
      actions.append(
        button('Copy without hidden characters', () =>
          host.post({ type: 'copyCleanSource', docKey }),
        ),
        button('Dismiss', () => {
          dismissed = key;
          bar.hidden = true;
          publishHeight();
        }),
      );
      actions.firstElementChild?.setAttribute('data-focus', 'copy');
      actions.lastElementChild?.setAttribute('data-focus', 'dismiss');
      actions.lastElementChild?.setAttribute('aria-label', 'Dismiss the hidden characters notice');
      top.append(message, actions);

      const details = document.createElement('details');
      details.open = detailsOpen;
      const summary = document.createElement('summary');
      summary.dataset.focus = 'summary';
      summary.textContent = plural(runs.length, 'Show the run', 'Show the runs');
      const list = document.createElement('ul');
      list.className = 'mc-hidden-list';
      for (const run of runs) {
        const item = document.createElement('li');
        const where = button(
          `Line ${run.line}, column ${run.column}`,
          () =>
            host.post({
              type: 'revealHidden',
              line: run.line,
              column: run.column,
              docKey,
              docVersion,
            }),
          'mc-hidden-link',
        );
        where.title = 'Go to this run in the editor';
        where.dataset.focus = `run:${run.line}:${run.column}`;
        const what = document.createElement('span');
        what.textContent = `: ${describeRun(run)}`;
        item.append(where, what);
        if (typeof run.decoded === 'string') {
          const spells = document.createElement('div');
          spells.className = 'mc-hidden-decoded-row';
          const label = document.createElement('span');
          label.textContent = 'Spells:';
          const code = document.createElement('code');
          code.className = 'mc-hidden-decoded';
          code.textContent = run.decoded;
          spells.append(label, code);
          item.append(spells);
        }
        list.append(item);
      }
      details.append(summary, list);
      if (scan.totalRuns > runs.length) {
        const more = document.createElement('p');
        more.className = 'mc-hidden-more';
        more.textContent = `Showing the first ${runs.length} of ${scan.totalRuns} runs.`;
        details.append(more);
      }
      bar.replaceChildren(top, details);
      list.scrollTop = listScroll;
      if (focusId !== undefined) {
        const again = Array.from(bar.querySelectorAll<HTMLElement>('[data-focus]')).find(
          (el) => el.dataset.focus === focusId,
        );
        again?.focus({ preventScroll: true });
      }
      publishHeight();
    },
  };
}
