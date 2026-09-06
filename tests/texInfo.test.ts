import { describe, expect, it } from 'vitest';
import {
  compileFailed,
  compileOffer,
  compileUnavailable,
  compiling,
  engineLabel,
  errorLocation,
  installHint,
} from '../src/texInfo';
import type { TexError } from '../src/texCompile';

describe('compiling', () => {
  it('names the file being compiled', () => {
    expect(compiling('paper.tex')).toBe('Compiling paper.tex…');
  });
});

describe('engineLabel', () => {
  it('gives every engine its human name', () => {
    expect(engineLabel('latexmk')).toBe('latexmk');
    expect(engineLabel('tectonic')).toBe('Tectonic');
    expect(engineLabel('pdflatex')).toBe('pdfTeX');
    expect(engineLabel('xelatex')).toBe('XeTeX');
    expect(engineLabel('lualatex')).toBe('LuaTeX');
  });
});

describe('compileOffer', () => {
  it('names the file and the engine', () => {
    const message = compileOffer('paper.tex', 'latexmk');
    expect(message).toContain('paper.tex');
    expect(message).toContain('latexmk');
  });

  it('reassures the reader the source is left alone', () => {
    // The one thing someone handed an unexpected "compile" button wants to
    // know before pressing it, same reasoning as videoInfo's proxyOffer.
    expect(compileOffer('paper.tex', 'tectonic')).toContain('without changing the file');
  });
});

describe('installHint', () => {
  it('points win32 at MiKTeX or TeX Live', () => {
    const message = installHint('win32');
    expect(message).toMatch(/MiKTeX/);
    expect(message).toMatch(/TeX Live/);
  });

  it('points darwin at MacTeX', () => {
    const message = installHint('darwin');
    expect(message).toMatch(/MacTeX/);
    expect(message).toMatch(/brew install --cask mactex-no-gui/);
  });

  it('points linux at the distro package', () => {
    expect(installHint('linux')).toMatch(/distro/);
  });

  it('mentions Tectonic on every platform, since a full install is multiple gigabytes', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as NodeJS.Platform[]) {
      expect(installHint(platform)).toMatch(/Tectonic/);
    }
  });
});

describe('compileUnavailable', () => {
  it('says what MarkCopy needs when no engine is installed, without scolding', () => {
    const message = compileUnavailable('missing', 'linux');
    expect(message).toMatch(/LaTeX engine/);
    expect(message).toMatch(/Tectonic/);
    expect(message).not.toMatch(/error/i);
  });

  it('names the setting when compiling is switched off', () => {
    const message = compileUnavailable('disabled', 'linux');
    expect(message).toContain('markcopy.tex.compile');
  });

  it('does not push an install on someone who turned compiling off', () => {
    expect(compileUnavailable('disabled', 'win32')).not.toMatch(/Install/);
  });
});

describe('errorLocation', () => {
  it('joins file and line when both are known', () => {
    expect(errorLocation({ file: 'chapters/one.tex', line: 12, message: 'x' })).toBe(
      'chapters/one.tex, line 12',
    );
  });

  it('falls back to the file alone when the line is missing', () => {
    expect(errorLocation({ file: 'chapters/one.tex', message: 'x' })).toBe('chapters/one.tex');
  });

  it('falls back to the line alone when the file is missing', () => {
    expect(errorLocation({ line: 12, message: 'x' })).toBe('line 12');
  });

  it('returns nothing when neither is known', () => {
    expect(errorLocation({ message: 'x' })).toBe('');
  });
});

describe('compileFailed', () => {
  it('leads with the first error location and message', () => {
    const errors: TexError[] = [
      { file: 'chapters/one.tex', line: 12, message: 'Undefined control sequence' },
    ];
    expect(compileFailed(errors)).toBe('chapters/one.tex, line 12: Undefined control sequence');
  });

  it('counts a single remaining error in the singular', () => {
    const errors: TexError[] = [
      { file: 'one.tex', line: 1, message: 'first' },
      { file: 'two.tex', line: 2, message: 'second' },
    ];
    expect(compileFailed(errors)).toBe('one.tex, line 1: first, and 1 more error.');
  });

  it('counts several remaining errors in the plural', () => {
    const errors: TexError[] = [
      { file: 'one.tex', line: 1, message: 'first' },
      { file: 'two.tex', line: 2, message: 'second' },
      { file: 'three.tex', line: 3, message: 'third' },
      { file: 'four.tex', line: 4, message: 'fourth' },
    ];
    expect(compileFailed(errors)).toBe('one.tex, line 1: first, and 3 more errors.');
  });

  it('falls back to an honest message when there is nothing to parse', () => {
    const message = compileFailed([]);
    expect(message).toMatch(/compile failed/i);
    // It must not send the reader to a log. An engine that leaves nothing for
    // the parser has usually died before writing one (MiKTeX's latexmk without
    // Perl is the motivating case), so naming a log file would be pointing at
    // something that is not there. The engine's own words are rendered directly
    // beneath this line instead.
    expect(message).not.toMatch(/log/i);
    expect(message).toMatch(/engine said:$/);
  });
});
