// A parsed review sidecar, following okstudio_video/schema/review.schema.json in
// owenpkent/okstudio-video-kit at 467ec02. Types only. The schema sets
// additionalProperties false everywhere, so these carry no extra fields.

export type ReviewTarget = 'source' | 'render';
export type ReviewKind = 'note' | 'keep' | 'reject';
export type ReviewStatus = 'none' | 'needs_review' | 'in_progress' | 'approved' | 'rejected';
export type DrawingTool = 'arrow' | 'line' | 'box' | 'free';

/** A point on the picture: x from the left, y from the top, each 0..1. */
export type ReviewPoint = [number, number];

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
  /** Seconds, 0 or more. */
  at: number;
  /** Seconds, greater than `at`. */
  out?: number;
  kind: ReviewKind;
  text?: string;
  color?: string;
  author?: string;
  point?: ReviewPoint;
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
  fps: number;
  /** Integer high-water mark, 1 or more. */
  next_note_id?: number;
  asset?: ReviewAsset;
  notes?: ReviewFileNote[];
}
