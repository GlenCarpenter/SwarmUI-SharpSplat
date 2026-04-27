"""ComfyUI custom node for SwarmUI SharpSplatextension.

Takes an IMAGE tensor, runs Apple ml-sharp predict to produce a Gaussian Splat PLY
file, converts it to the compact .splat binary format via ply2splat, and writes the
result to the caller-specified output_path on disk.

The C# side (SharpSplatAPI.SharpGenerateSplatViaComfy) is responsible for:
  - determining the absolute output_path before submitting the workflow
  - verifying the file exists after the workflow completes
  - returning the URL to the browser

Dependencies (ml-sharp, ply2splat) are installed on first use via the extension's
requirements.txt using the same Python executable that is running ComfyUI.
"""

import os
import sys
import subprocess
import tempfile
import shutil
from pathlib import Path

# Absolute path to the extension root (parent of this ComfyNodes folder).
_EXT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _ensure_deps():
    """Installs ml-sharp and ply2splat via pip if they are not yet importable."""
    try:
        import sharp  # noqa: F401
        import ply2splat  # noqa: F401
    except ImportError:
        req_path = os.path.join(_EXT_DIR, "requirements.txt")
        if not os.path.exists(req_path):
            raise RuntimeError(f"[SharpSplat] requirements.txt not found at {req_path}")
        print("[SharpSplat] Installing ml-sharp dependencies...")
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "--quiet", "-r", req_path],
            check=True,
        )
        print("[SharpSplat] Dependencies installed.")


class SharpSplatGenerate:
    """Generates a 3D Gaussian Splat (.splat) file from the input image."""

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "images": ("IMAGE",),
                "output_path": ("STRING", {"default": ""}),
            }
        }

    CATEGORY = "SharpSplat"
    RETURN_TYPES = ()
    FUNCTION = "generate_splat"
    OUTPUT_NODE = True
    DESCRIPTION = (
        "Generates a 3D Gaussian Splat (.splat) file from the input image using "
        "Apple ml-sharp. The result is written to output_path on disk. "
        "Intended for use with SwarmUI's SharpSplat extension."
    )

    def generate_splat(self, images, output_path):
        import numpy as np
        from PIL import Image as PILImage

        if not output_path:
            raise ValueError("[SharpSplat] output_path must not be empty.")

        _ensure_deps()

        # Take the first image from the batch.
        i = 255.0 * images[0].cpu().numpy()
        img = PILImage.fromarray(i.clip(0, 255).astype("uint8"))

        temp_root = tempfile.mkdtemp(prefix="sharpsplat_")
        input_dir = os.path.join(temp_root, "input")
        ply_dir = os.path.join(temp_root, "ply_output")
        os.makedirs(input_dir)
        os.makedirs(ply_dir)

        try:
            # Save input image for ml-sharp.
            input_image_path = os.path.join(input_dir, "image.png")
            img.save(input_image_path)

            # Run ml-sharp predict via the extension's wrapper script.
            run_sharp_path = os.path.join(_EXT_DIR, "run_sharp.py")
            sharp_result = subprocess.run(
                [sys.executable, "-s", run_sharp_path, "predict", "-i", input_dir, "-o", ply_dir],
                capture_output=True,
                text=True,
            )
            if sharp_result.stdout.strip():
                print(f"[SharpSplat] sharp stdout: {sharp_result.stdout.strip()}")
            if sharp_result.returncode != 0:
                raise RuntimeError(
                    f"[SharpSplat] ml-sharp predict failed (exit {sharp_result.returncode}): "
                    f"{sharp_result.stderr.strip()}"
                )

            # Locate the generated PLY file.
            ply_files = list(Path(ply_dir).rglob("*.ply"))
            if not ply_files:
                raise RuntimeError("[SharpSplat] ml-sharp produced no PLY output.")
            ply_path = str(ply_files[0])

            # Ensure the output directory exists (C# creates it, but be safe).
            os.makedirs(os.path.dirname(output_path), exist_ok=True)

            # Convert PLY → .splat via the extension's converter script.
            run_convert_path = os.path.join(_EXT_DIR, "run_convert.py")
            convert_result = subprocess.run(
                [sys.executable, "-s", run_convert_path, ply_path, output_path],
                capture_output=True,
                text=True,
            )
            if convert_result.stdout.strip():
                print(f"[SharpSplat] convert stdout: {convert_result.stdout.strip()}")
            if convert_result.returncode != 0:
                raise RuntimeError(
                    f"[SharpSplat] PLY to .splat conversion failed (exit {convert_result.returncode}): "
                    f"{convert_result.stderr.strip()}"
                )
            if not os.path.exists(output_path):
                raise RuntimeError("[SharpSplat] Conversion reported success but output file is missing.")

            print(f"[SharpSplat] Saved {os.path.getsize(output_path)} bytes to {output_path}")
        finally:
            shutil.rmtree(temp_root, ignore_errors=True)

        return ()


NODE_CLASS_MAPPINGS = {
    "SharpSplatGenerate": SharpSplatGenerate,
}
