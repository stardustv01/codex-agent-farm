#!/usr/bin/env python3
"""Build a coherent eight-frame look row from approved cardinal cells."""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image


def blend(left: Image.Image, right: Image.Image, amount: float) -> Image.Image:
    return Image.blend(left.convert("RGBA"), right.convert("RGBA"), amount)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--anchors-dir", required=True)
    parser.add_argument("--half", choices=("first", "second"), required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    root = Path(args.anchors_dir)
    anchors = {name: Image.open(root / f"{name}.png").convert("RGBA") for name in ("000", "090", "180", "270")}
    if args.half == "first":
        sequence = [("000", "090", value / 4) for value in range(4)] + [("090", "180", value / 4) for value in range(4)]
    else:
        sequence = [("180", "270", value / 4) for value in range(4)] + [("270", "000", value / 4) for value in range(4)]
    row = Image.new("RGBA", (192 * 8, 208), (0, 0, 0, 0))
    for index, (start, end, amount) in enumerate(sequence):
        row.alpha_composite(blend(anchors[start], anchors[end], amount), (index * 192, 0))
    row.save(args.output)


if __name__ == "__main__":
    main()
