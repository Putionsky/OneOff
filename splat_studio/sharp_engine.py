"""Adapter for Apple's SHARP — photorealistic 3D gaussians from a single image.

SHARP is not bundled with this app. Install it once (needs Python 3.10+ and
PyTorch; the first run downloads the model weights from Hugging Face):

    pip install "git+https://github.com/apple/ml-sharp.git"

The engine shells out to the SHARP CLI, so any compatible image-to-3DGS tool
can be plugged in through the SHARP_CMD environment variable. The command is
a template with two placeholders:

    SHARP_CMD='sharp predict -i {input} -o {output_dir}'   (default)

Whatever the command writes, the newest .ply file found under {output_dir}
after it exits is taken as the resulting gaussian scene.
"""

from __future__ import annotations

import os
import shlex
import shutil
import subprocess
from pathlib import Path

DEFAULT_CMD = "sharp predict -i {input} -o {output_dir}"

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}


def command_template() -> str:
    return os.environ.get("SHARP_CMD", DEFAULT_CMD)


def available() -> bool:
    exe = shlex.split(command_template())[0]
    return shutil.which(exe) is not None


def install_hint() -> str:
    return (
        "SHARP is not installed. Install it with:  "
        'pip install "git+https://github.com/apple/ml-sharp.git"  '
        "(or point SHARP_CMD at a compatible image-to-3DGS command, e.g. "
        "SHARP_CMD='sharp predict -i {input} -o {output_dir}')"
    )


def run(image_path: str | Path, output_dir: str | Path, timeout: int = 900) -> Path:
    """Run SHARP on one image and return the produced 3DGS .ply path."""
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    before = {p: p.stat().st_mtime for p in output_dir.rglob("*.ply")}

    cmd = [a.format(input=str(image_path), output_dir=str(output_dir))
           for a in shlex.split(command_template())]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-8:]
        raise RuntimeError(
            f"SHARP failed (exit {proc.returncode}) running: {' '.join(cmd)}\n"
            + "\n".join(tail))

    plys = [p for p in output_dir.rglob("*.ply")
            if p not in before or p.stat().st_mtime > before[p]]
    if not plys:
        plys = list(output_dir.rglob("*.ply"))
    if not plys:
        raise RuntimeError(
            f"SHARP finished but produced no .ply under {output_dir} "
            f"(command: {' '.join(cmd)})")
    return max(plys, key=lambda p: p.stat().st_mtime)
