// A parsed review sidecar, following okstudio_video/schema/review.schema.json in
// owenpkent/okstudio-video-kit (video notes at 467ec02; `media` and `region` from
// PR #4, branch feat/image-region; `media: audio` from feat/audio-media). Types only. The schema sets
// additionalProperties false everywhere, so these carry no extra fields.

export type ReviewMedia = 'video' | 'image' | 'audio';
export type ReviewTarget = 'source' | 'render';
export type ReviewKind = 'note' | 'keep' | 'reject';
export type ReviewStatus = 'none' | 'needs_review' | 'in_progress' | 'approved' | 'rejected';
export type DrawingTool = 'arrow' | 'line' | 'box' | 'free';

/** A point on the picture: x from the left, y from the top, each 0..1. */
export type ReviewPoint = [number, number];

/** An area of the picture: `[x, y, w, h]`, each 0..1, positive size, inside the picture. */
export type ReviewRegion = [number, number, number, number];

export interface ReviewDrawing {
  tool: DrawingTool;
  color?: string;
  points: ReviewPoint[];
}

export interface ReviewAsset {
  /** Integer 0..5. */
  rating?: number;
  status?: ReviewStatus;
  keywords?: string[];
  notes?: string;
}

export interface ReviewFileNote {
  id: string;
  target: ReviewTarget;
  /** Seconds, 0 or more. Required for a video or audio file, absent from an image's notes. */
  at?: number;
  /** Seconds, greater than `at`. */
  out?: number;
  kind: ReviewKind;
  text?: string;
  color?: string;
  author?: string;
  point?: ReviewPoint;
  /** Never together with `point`. */
  region?: ReviewRegion;
  done: boolean;
  applied_op?: string | null;
  checkpoint?: string | null;
  drawing?: ReviewDrawing[];
  /** Local time, `YYYY-MM-DDTHH:MM:SS`. */
  created: string;
}

export interface ReviewFile {
  version: 1;
  id?: string;
  source: string;
  /** Absent means video. */
  media?: ReviewMedia;
  /** Required for a video, optional for an image or audio file (and then still above 0). */
  fps?: number;
  /** Integer high-water mark, 1 or more. */
  next_note_id?: number;
  asset?: ReviewAsset;
  notes?: ReviewFileNote[];
}
