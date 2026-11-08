"""Regenerate the golden review fixtures with okstudio-video-kit.

Each fixture is a sidecar (<name>.review.yaml) and the markdown the kit's
Review.export_markdown writes for it (<name>.review.md). The vitest suite
parses the YAML, runs reviewMarkdown and compares with the checked-in .md byte
for byte. This script needs Python and the kit, so CI only compares and never
regenerates; run it by hand when the kit's format changes and commit the result.

    python generate.py          # every fixture
    python generate.py image    # only image/ (Image Notes, needs the kit's feat/image-region)

Ids and timestamps are fixed below so a rerun gives identical files.

It also writes edit/<case>.before.review.yaml and edit/<case>.after.review.yaml
pairs: the kit's own add_note, update_note and remove_note applied to the "before"
sidecar and saved. tests/videoReview.test.ts applies MarkCopy's operation to the
before file and requires the after file byte for byte. edit/cases.json says which
operation each pair is.

The image/ folder holds the same for Image Notes (media: image, named after the full
file name: photo.png.review.yaml) and a video review whose notes carry a region.
"""
from __future__ import annotations

import json
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


def three() -> Path:
    """Three notes, one done, for removing from the start, middle and end."""
    rev = build("three", 25, "cccccccccccc")
    add(rev, at=1.0, text="First.")
    done = add(rev, at=2.0, out=3.5, text="Second.")
    done["done"] = True
    add(rev, at=9.0, text="Third.")
    finish(rev)
    return rev.path


def empty() -> Path:
    """A sidecar with no notes yet: the state Review.new saves before the first one."""
    rev = build("empty", 30, "dddddddddddd")
    finish(rev)
    return rev.path


LONG = (
    "The pan loses focus as the subject walks past the window, and the highlights on "
    "the glass clip hard before the cut, so please check both takes."
)

# name, base fixture, operation, arguments (ids and times are what the test passes in)
CASES = [
    ("add-point", "minimal", "add", {"at": 2.5, "text": "Cut on the beat."}),
    ("add-range", "minimal", "add", {"at": 8.0, "out": 9.25, "text": "Hold this shot."}),
    ("add-long-text", "minimal", "add", {"at": 3.0, "text": LONG}),
    ("add-multiline", "minimal", "add", {"at": 3.0, "text": "Line one.\n\nLine two: 'quoted' and more."}),
    ("add-empty-text", "minimal", "add", {"at": 3.0, "text": ""}),
    ("add-reserved-words", "minimal", "add", {"at": 3.0, "text": "yes"}),
    ("add-number-text", "minimal", "add", {"at": 3.0, "text": "12"}),
    ("add-unicode", "minimal", "add", {"at": 3.0, "text": "Café ☃ \U0001F600, tab\there"}),
    ("add-first", "empty", "add", {"at": 1.0, "text": "First note."}),
    ("add-to-full", "full", "add", {"at": 61.5, "out": 62.0, "text": "New on a rich file."}),
    ("add-pin", "minimal", "add", {"at": 2.5, "text": "Logo here.", "point": [0.42, 0.3]}),
    ("add-pin-range", "minimal", "add", {"at": 8.0, "out": 9.25, "text": "Track this.", "point": [0.5, 0.75]}),
    ("add-pin-clean", "minimal", "add", {"at": 3.0, "text": "Rounded.", "point": [0.123456789, 0.99996]}),
    ("add-pin-edges", "minimal", "add", {"at": 3.0, "text": "Corners.", "point": [0, 1]}),
    ("add-pin-to-full", "full", "add", {"at": 61.5, "text": "On a rich file.", "point": [0.0001, 0.3333333]}),
    ("remove-first", "three", "remove", {"id": "n1"}),
    ("remove-middle", "three", "remove", {"id": "n2"}),
    ("remove-last", "three", "remove", {"id": "n3"}),
    ("remove-from-full", "full", "remove", {"id": "n3"}),
]


def edits() -> None:
    out = HERE / "edit"
    out.mkdir(exist_ok=True)
    bases = {
        "minimal": HERE / "minimal.review.yaml",
        "full": HERE / "full.review.yaml",
        "three": three(),
        "empty": empty(),
    }
    for name, base, op, args in CASES:
        before = out / f"{name}.before.review.yaml"
        after = out / f"{name}.after.review.yaml"
        before.write_bytes(Path(bases[base]).read_bytes())
        rev = Review.load(before)
        rev.path = after
        if op == "add":
            note = rev.add_note(
                at=args["at"], out=args.get("out"), text=args["text"], point=args.get("point")
            )
            note["created"] = CREATED
        elif op == "done":
            rev.update_note(args["id"], done=args["done"])
        else:
            assert rev.remove_note(args["id"])
        rev.validate()
        rev.save()
        after.write_bytes(after.read_bytes().replace(b"\r\n", b"\n"))
    cases = [{"name": n, "op": o, "args": a} for n, _, o, a in CASES]
    (out / "cases.json").write_text(json.dumps(cases, indent=2) + "\n", encoding="utf-8")
    # The bases made here are only inputs; keep them out of the top level, where the
    # suite treats every *.review.yaml as a fixture that has a markdown twin.
    for extra in ("three", "empty"):
        for ext in ("review.yaml", "review.md"):
            (HERE / f"{extra}.{ext}").unlink(missing_ok=True)


IMAGE = HERE / "image"
IMAGE_CASES = [
    # name, base, arguments
    ("add-whole", "empty", {"text": "Crop is too tight."}),
    ("add-pin", "empty", {"text": "Dust spot here.", "point": [0.42, 0.3]}),
    ("add-region", "empty", {"text": "Re-light this.", "region": [0.1, 0.2, 0.3, 0.4]}),
    ("add-region-clean", "empty", {"text": "Rounded.", "region": [0.123456789, 0.99991, 0.50004, 0.00006]}),
    ("add-region-tie", "empty", {"text": "Tie.", "region": [0.03125, 0.09375, 0.15625, 0.21875]}),
    ("add-region-flush", "empty", {"text": "Edge to edge.", "region": [0, 0, 1, 1]}),
    ("add-region-flush-far", "empty", {"text": "Far corner.", "region": [0.3333, 0.6667, 0.6667, 0.3333]}),
    ("add-region-slack", "empty", {"text": "Slack.", "region": [0.3, 0.3, 0.7000000001, 0.7]}),
    ("add-empty-text", "empty", {"text": ""}),
    ("add-multiline", "empty", {"text": "Line one.\n\nLine two: 'quoted' and more."}),
    ("add-unicode", "empty", {"text": "Café ☃ 😀, tab\there"}),
    ("add-to-full", "full", {"text": "New on a rich file.", "region": [0.5, 0.5, 0.25, 0.25]}),
    ("add-pin-to-full", "full", {"text": "Pin on a rich file.", "point": [0.0001, 0.3333333]}),
]


def image_review(name: str, rid: str) -> Review:
    rev = Review.new(name, None, IMAGE / f"{name}.review.yaml", media="image")
    rev.data["id"] = rid
    return rev


def images() -> None:
    IMAGE.mkdir(exist_ok=True)
    (IMAGE / "edit").mkdir(exist_ok=True)

    # A rich image review and its markdown.
    rev = image_review("full.png", "eeeeeeeeeeee")
    rev.set_asset(rating=3, status="in_progress", keywords=["hero", "retouch"], notes="First pass.")
    add(rev, text="Whole picture is too warm.")
    add(rev, text="Dust here.", point=[0.126, 0.5], author="Dana")
    add(rev, text="Re-light this corner.", region=[0.1, 0.25, 0.375, 0.5])
    add(rev, text="")
    done = add(rev, text="Fixed already.", region=[0.0, 0.0, 1.0, 1.0])
    done["done"] = True
    finish(rev)

    # An image review with no notes yet: what Review.new saves.
    rev = image_review("empty.png", "dddddddddddd")
    finish(rev)

    # A video review whose notes carry a region (an Area: line in the markdown).
    rev = Review.new("clip.mp4", 25, IMAGE / "video-region.review.yaml")
    rev.data["id"] = "ffffffffffff"
    add(rev, at=1.0, text="Region only.", region=[0.1, 0.2, 0.3, 0.4])
    add(rev, at=2.0, out=3.0, text="Range with a region.", region=[0.0, 0.0, 0.5, 0.5], author="Dana")
    add(rev, at=4.0, text="Pin only.", point=[0.5, 0.5])
    finish(rev)

    # The kit's own add_note on each base, saved to the "after" file.
    out = IMAGE / "edit"
    bases = {"empty": IMAGE / "empty.png.review.yaml", "full": IMAGE / "full.png.review.yaml"}
    for name, base, args in IMAGE_CASES:
        before = out / f"{name}.before.review.yaml"
        after = out / f"{name}.after.review.yaml"
        before.write_bytes(bases[base].read_bytes())
        rev = Review.load(before)
        rev.path = after
        note = rev.add_note(
            text=args["text"], point=args.get("point"), region=args.get("region")
        )
        note["created"] = CREATED
        rev.validate()
        rev.save()
        after.write_bytes(after.read_bytes().replace(b"\r\n", b"\n"))
    cases = [{"name": n, "base": b, "args": a} for n, b, a in IMAGE_CASES]
    (out / "cases.json").write_text(json.dumps(cases, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    import sys

    if "image" not in sys.argv[1:]:
        minimal()
        full()
        edits()
    images()
