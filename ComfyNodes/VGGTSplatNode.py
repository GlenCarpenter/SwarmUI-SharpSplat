"""ComfyUI custom node for VGGT-based Gaussian splat generation.

Accepts a JSON-encoded array of base64 image strings, runs VGGT inference via
run_vggt.py, and writes a Gaussian splat PLY (or .splat) file to output_path.

The C# side (SharpSplatAPI.VGGTGenerateSplatViaComfy) is responsible for:
  - building the base64 array and serialising it to JSON
  - determining the absolute output_path before submitting the workflow
  - verifying the file exists after the workflow completes
  - returning the URL to the browser
"""

import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile

# Absolute path to the extension root (parent of this ComfyNodes folder).
_EXT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

if _EXT_DIR not in sys.path:
    sys.path.insert(0, _EXT_DIR)
from pinned_stack import pip_install  # noqa: E402


def _ensure_deps():
    """Installs VGGT and huggingface_hub via pip if they are not yet importable."""
    try:
        import vggt  # noqa: F401
        import huggingface_hub  # noqa: F401
    except ImportError:
        req_path = os.path.join(_EXT_DIR, "requirements.txt")
        if not os.path.exists(req_path):
            raise RuntimeError(f"[VGGTSplat] requirements.txt not found at {req_path}")
        print("[VGGTSplat] Installing VGGT dependencies...")
        pip_install(requirements=req_path)
        print("[VGGTSplat] Dependencies installed.")


class VGGTSplatGenerate:
    """Generates a Gaussian splat PLY from one or more images using VGGT."""

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "images_base64_json": ("STRING", {"default": "[]"}),
                "output_path": ("STRING", {"default": ""}),
                "output_format": (["ply", "splat"], {"default": "ply"}),
                "pad_to_square": ("BOOLEAN", {"default": False}),
            }
        }

    CATEGORY = "SharpSplat"
    RETURN_TYPES = ()
    FUNCTION = "generate_splat"
    OUTPUT_NODE = True
    DESCRIPTION = (
        "Generates a Gaussian splat PLY (or .splat) from multiple images using VGGT. "
        "images_base64_json must be a JSON array of base64-encoded PNG/JPG strings. "
        "The result is written to output_path on disk. "
        "Intended for use with SwarmUI's SharpSplat extension."
    )

    def generate_splat(self, images_base64_json, output_path, output_format="ply", pad_to_square=False):
        if not output_path:
            raise ValueError("[VGGTSplat] output_path must not be empty.")

        if output_format not in ("ply", "splat"):
            output_format = "ply"

        # Decode the JSON array of base64 strings.
        try:
            images_b64_list = json.loads(images_base64_json)
        except json.JSONDecodeError as exc:
            raise ValueError(f"[VGGTSplat] images_base64_json is not valid JSON: {exc}") from exc

        if not images_b64_list:
            raise ValueError("[VGGTSplat] images_base64_json contains no images.")

        _ensure_deps()

        temp_root = tempfile.mkdtemp(prefix="vggtsplat_")
        input_dir = os.path.join(temp_root, "images")
        vggt_output_dir = os.path.join(temp_root, "output")
        os.makedirs(input_dir)
        os.makedirs(vggt_output_dir)

        try:
            # Write decoded images to the temp input directory.
            for idx, b64_str in enumerate(images_b64_list):
                img_bytes = base64.b64decode(b64_str)
                img_path = os.path.join(input_dir, f"image_{idx:04d}.png")
                with open(img_path, "wb") as fh:
                    fh.write(img_bytes)

            # Run VGGT inference via the extension's wrapper script.
            run_vggt_path = os.path.join(_EXT_DIR, "run_vggt.py")
            vggt_cmd = [
                sys.executable, "-s", run_vggt_path,
                "--image_dir", input_dir,
                "--output_dir", vggt_output_dir,
            ]
            if pad_to_square:
                vggt_cmd.append("--pad_to_square")
            vggt_result = subprocess.run(
                vggt_cmd,
                capture_output=True,
                text=True,
            )
            if vggt_result.stdout.strip():
                print(f"[VGGTSplat] vggt stdout: {vggt_result.stdout.strip()}")
            if vggt_result.stderr.strip():
                print(f"[VGGTSplat] vggt stderr: {vggt_result.stderr.strip()}", file=sys.stderr)
            if vggt_result.returncode != 0:
                raise RuntimeError(
                    f"[VGGTSplat] run_vggt.py failed (exit {vggt_result.returncode}): "
                    f"{vggt_result.stderr.strip()}"
                )

            # Locate the generated PLY file.
            from pathlib import Path
            ply_files = list(Path(vggt_output_dir).rglob("*.ply"))
            if not ply_files:
                raise RuntimeError("[VGGTSplat] run_vggt.py produced no PLY output.")
            ply_path = str(ply_files[0])

            os.makedirs(os.path.dirname(output_path), exist_ok=True)

            if output_format == "splat":
                run_convert_path = os.path.join(_EXT_DIR, "run_convert.py")
                convert_result = subprocess.run(
                    [sys.executable, "-s", run_convert_path, ply_path, output_path],
                    capture_output=True,
                    text=True,
                )
                if convert_result.stdout.strip():
                    print(f"[VGGTSplat] convert stdout: {convert_result.stdout.strip()}")
                if convert_result.returncode != 0:
                    raise RuntimeError(
                        f"[VGGTSplat] PLY to .splat conversion failed "
                        f"(exit {convert_result.returncode}): {convert_result.stderr.strip()}"
                    )
                if not os.path.exists(output_path):
                    raise RuntimeError("[VGGTSplat] Conversion reported success but output file is missing.")
            else:
                shutil.copy2(ply_path, output_path)
                if not os.path.exists(output_path):
                    raise RuntimeError("[VGGTSplat] PLY copy failed — output file is missing.")

            print(f"[VGGTSplat] Saved {os.path.getsize(output_path)} bytes to {output_path}")
        finally:
            shutil.rmtree(temp_root, ignore_errors=True)

        return ()


NODE_CLASS_MAPPINGS = {
    "VGGTSplatGenerate": VGGTSplatGenerate,
}
