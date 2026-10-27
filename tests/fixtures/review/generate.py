"""Regenerate the golden review fixtures with okstudio-video-kit.

Each fixture is a sidecar (<name>.review.yaml) and the markdown the kit's
Review.export_markdown writes for it (<name>.review.md). The vitest suite
parses the YAML, runs reviewMarkdown and compares with the checked-in .md byte
for byte. This script needs Python and the kit, so CI only compares and never
regenerates; run it by hand when the kit's format changes and commit the result.

    python generate.py

Ids and timestamps are fixed below so a rerun gives identical files.
"""
from __future__ import annotations

from pathlib import Path

from okstudio_video.review import Review  # pyright: ignore[reportMissingImports]

HERE = Path(__file__).resolve().parent
CREATED = "2026-01-02T03:04:05"


def build(name: str, fps: float, rid: str) -> Review:
    rev = Review.new(f"{name}.mp4", fps, HERE / f"{name}.review.yaml")
    rev.data["id"] = rid
    return rev


def add(rev: Review, **kw) -> dict:
    note = rev.add_note(**kw)
    note["created"] = CREATED
    return note


def finish(rev: Review) -> None:
    rev.validate()
    rev.save()
    md = rev.export_markdown()
    # Windows writes CRLF; the fixtures are LF so the byte comparison is portable.
    for path in (rev.path, md):
        data = Path(path).read_bytes().replace(b"\r\n", b"\n")
        Path(path).write_bytes(data)


def minimal() -> None:
    rev = build("minimal", 30, "aaaaaaaaaaaa")
    add(rev, at=1.0, text="Soft focus through the whole pan.")
    add(rev, at=4.5, out=6.0, text="Cut this range.")
    finish(rev)


def full() -> None:
    rev = build("full", 29.97, "bbbbbbbbbbbb")
    rev.set_asset(
        rating=4,
        status="needs_review",
        keywords=["interview", "b-roll"],
        notes="Second pass.\nWatch the audio levels.",
    )
    add(rev, at=0.5, text="Logo is too small.", author="Dana", point=[0.126, 0.5])
    add(rev, at=600.0, out=612.5, text="Range note across the cut.")
    add(rev, at=20.0, text="")
    add(rev, at=30.0, out=35.0, kind="keep", text="Best take.")
    add(rev, at=40.0, kind="reject", text="Out of focus.")
    done = add(rev, at=50.0, text="Fixed in the last export.")
    done["done"] = True
    add(rev, target="render", at=7.25, text="Title overlaps the lower third.")
    finish(rev)


if __name__ == "__main__":
    minimal()
    full()
