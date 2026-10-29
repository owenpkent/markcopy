import {
  audioCodecLabel,
  canRemux,
  codecLabel,
  parseProbe,
  parseProgressSeconds,
  silentAudio,
} from '../../src/videoProxy';

// The input is ffprobe's JSON, a NUL, then a chunk of ffmpeg `-progress` output
// (the seeds are laid out that way). parseProbe and parseProgressSeconds answer
// junk with a blank result, so nothing is wrapped.
export function fuzz(data: Buffer): void {
  const text = data.toString('utf8');
  const split = text.indexOf('\0');
  const json = split < 0 ? text : text.slice(0, split);
  const chunk = split < 0 ? text : text.slice(split + 1);

  const probe = parseProbe(json);
  codecLabel(probe);
  canRemux(probe, 'clip.mkv');
  canRemux(probe, 'clip.mov');
  silentAudio(probe);
  audioCodecLabel(probe);
  parseProgressSeconds(chunk);
}
