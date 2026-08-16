#!/usr/bin/env python3
"""Extract Luna strips while preserving enclosed magenta identity details."""

from __future__ import annotations

import argparse
import importlib.util
import math
import json
from collections import deque
from pathlib import Path

from PIL import Image


def load_hatch_extractor():
    path = Path.home() / ".codex/skills/hatch-pet/scripts/extract_strip_frames.py"
    spec = importlib.util.spec_from_file_location("hatch_extract", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def distance(pixel: tuple[int, int, int, int], key: tuple[int, int, int]) -> float:
    return math.sqrt(sum((pixel[index] - key[index]) ** 2 for index in range(3)))


def clear_boundary_key(image: Image.Image, key: tuple[int, int, int], threshold: float) -> Image.Image:
    rgba = image.convert("RGBA")
    width, height = rgba.size
    pixels = rgba.load()
    visited = bytearray(width * height)
    queue: deque[tuple[int, int]] = deque()

    def enqueue(x: int, y: int) -> None:
        offset = y * width + x
        if not visited[offset] and distance(pixels[x, y], key) <= threshold:
            visited[offset] = 1
            queue.append((x, y))

    for x in range(width):
        enqueue(x, 0)
        enqueue(x, height - 1)
    for y in range(height):
        enqueue(0, y)
        enqueue(width - 1, y)

    while queue:
        x, y = queue.popleft()
        pixels[x, y] = (0, 0, 0, 0)
        if x:
            enqueue(x - 1, y)
        if x + 1 < width:
            enqueue(x + 1, y)
        if y:
            enqueue(x, y - 1)
        if y + 1 < height:
            enqueue(x, y + 1)
    return rgba


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--strip", required=True)
    parser.add_argument("--state", required=True)
    parser.add_argument("--frames", required=True, type=int)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--key", default="#FF00FF")
    parser.add_argument("--threshold", type=float, default=160)
    args = parser.parse_args()

    key = tuple(int(args.key[index:index + 2], 16) for index in (1, 3, 5))
    with Image.open(args.strip) as opened:
        cleared = clear_boundary_key(opened, key, args.threshold)
    hatch = load_hatch_extractor()
    frames = hatch.extract_component_frames(cleared, args.frames)
    if frames is None:
        frames = hatch.extract_stable_slot_frames(cleared, args.frames)
    state_dir = Path(args.output_dir) / args.state
    state_dir.mkdir(parents=True, exist_ok=True)
    for index, frame in enumerate(frames):
        frame.save(state_dir / f"{index:02d}.png")
    manifest_path = Path(args.output_dir) / "frames-manifest.json"
    payload = {"ok": True, "extraction": "boundary-connected-chroma", "rows": []}
    if manifest_path.is_file():
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    row = {
        "state": args.state,
        "frames": [str(state_dir / f"{index:02d}.png") for index in range(len(frames))],
        "method": "boundary-connected-components",
    }
    payload["rows"] = [entry for entry in payload.get("rows", []) if entry.get("state") != args.state]
    payload["rows"].append(row)
    manifest_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
