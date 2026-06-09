#!/usr/bin/env python3
"""
run_triposplat.py — TripoSplat inference wrapper for direct subprocess invocation.

Uses ComfyUI's Python environment and native TripoSplat node implementations
(comfy-core ≥ v0.22.0). Invoked by SharpSplatAPI.TripoSplatGenerateSplat when
no ComfyUI backend is running as a fallback path.

BuildPythonPsi (in SharpSplatAPI.cs) sets the working directory to
dlbackend/comfy/ so that all ComfyUI modules are importable.

Usage:
    python -s run_triposplat.py --image <path> --output <path>
                                [--output_format ply|splat]
                                [--num_gaussians 262144]
                                [--seed 0]
                                [--no_bg_removal]
"""

import argparse
import os
import shutil
import subprocess
import sys

_TAG = "[TripoSplat]"


def _get_attr(d, keys):
    """Return the first matching key's value from dict d, converted to a numpy array."""
    import numpy as np

    for k in keys:
        if k in d:
            v = d[k]
            if hasattr(v, "detach"):
                return v.detach().cpu().float().numpy()
            return np.asarray(v, dtype=np.float32)
    return None


def _write_ply_from_splat(splat, output_path):
    """Serialise a ComfyUI Types.SPLAT object to a standard 3DGS PLY file.

    splat has attributes:
      .positions  (B, N, 3)  world-space centres
      .scales     (B, N, 3)  linear (positive) per-axis std
      .rotations  (B, N, 4)  quaternion wxyz (normalised)
      .opacities  (B, N, 1)  in [0, 1]
      .sh         (B, N, K, 3) spherical-harmonic colour coefficients
      .counts     (B,) or None — real per-item lengths
    Activations are inverted to standard 3DGS storage convention (log scale, logit opacity).
    """
    import numpy as np

    N = int(splat.counts[0].item()) if splat.counts is not None else splat.positions.shape[1]

    xyz     = splat.positions[0, :N].cpu().float().numpy()           # (N, 3)
    scales  = splat.scales[0,    :N].cpu().float().numpy()           # (N, 3) linear
    rot     = splat.rotations[0, :N].cpu().float().numpy()           # (N, 4) wxyz
    op      = splat.opacities[0, :N].cpu().float().numpy().reshape(N, 1)  # (N, 1)
    sh      = splat.sh[0,        :N].cpu().float().numpy()           # (N, K, 3)

    normals  = np.zeros_like(xyz)
    f_dc     = sh[:, 0, :]                                           # (N, 3)
    f_rest   = sh[:, 1:, :].transpose(0, 2, 1).reshape(N, -1)       # (N, 3*(K-1)) channel-major

    # Invert activations to standard 3DGS storage convention
    op_stored    = np.log(op.clip(1e-6, 1 - 1e-6) / (1.0 - op.clip(1e-6, 1 - 1e-6)))  # logit
    scale_stored = np.log(scales.clip(min=1e-8))

    attrs = (
        ['x', 'y', 'z', 'nx', 'ny', 'nz']
        + [f'f_dc_{i}' for i in range(3)]
        + [f'f_rest_{i}' for i in range(f_rest.shape[1])]
        + ['opacity']
        + [f'scale_{i}' for i in range(3)]
        + [f'rot_{i}' for i in range(4)]
    )
    data = np.concatenate([xyz, normals, f_dc, f_rest, op_stored, scale_stored, rot], axis=1)
    elements = np.empty(N, dtype=[(a, 'f4') for a in attrs])
    elements[:] = list(map(tuple, data))

    header = (
        "ply\nformat binary_little_endian 1.0\n"
        f"element vertex {N}\n"
        + "".join(f"property float {a}\n" for a in attrs)
        + "end_header\n"
    )
    with open(output_path, "wb") as fh:
        fh.write(header.encode("ascii"))
        fh.write(elements.tobytes())

    print(f"{_TAG} Wrote PLY: {N} Gaussians → {output_path}")


def _hf_download(repo_id: str, hf_filename: str, local_dir: str) -> None:
    """Download a single file from HuggingFace Hub into local_dir.

    Downloads to a temporary directory first, then moves only the bare file
    into local_dir to avoid hf_hub_download recreating the repo subdirectory
    structure inside local_dir.
    """
    import inspect
    import tempfile

    try:
        from huggingface_hub import hf_hub_download
    except ImportError:
        print(f"{_TAG} huggingface_hub not found — installing...")
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "--quiet", "huggingface_hub"],
            check=True,
        )
        from huggingface_hub import hf_hub_download

    os.makedirs(local_dir, exist_ok=True)
    basename = os.path.basename(hf_filename)
    final_path = os.path.join(local_dir, basename)
    print(f"{_TAG} Downloading {repo_id}/{hf_filename} → {final_path}")

    with tempfile.TemporaryDirectory(prefix="sharpsplat_hf_") as tmp:
        kwargs = dict(repo_id=repo_id, filename=hf_filename, local_dir=tmp)
        if "local_dir_use_symlinks" in inspect.signature(hf_hub_download).parameters:
            kwargs["local_dir_use_symlinks"] = False
        downloaded = hf_hub_download(**kwargs)
        shutil.move(downloaded, final_path)

    print(f"{_TAG} Downloaded → {final_path}")


def _ensure_models(folder_paths_mod, no_bg: bool = False) -> None:
    """Download any missing TripoSplat model weights from HuggingFace."""
    _REQUIRED = [
        (
            "diffusion_models",
            "triposplat_fp16.safetensors",
            "VAST-AI/TripoSplat",
            "diffusion_models/triposplat_fp16.safetensors",
        ),
        (
            "clip_vision",
            "dino_v3_vit_h.safetensors",
            "VAST-AI/TripoSplat",
            "clip_vision/dino_v3_vit_h.safetensors",
        ),
        (
            "vae",
            "triposplat_vae_decoder_fp16.safetensors",
            "VAST-AI/TripoSplat",
            "vae/triposplat_vae_decoder_fp16.safetensors",
        ),
        (
            "vae",
            "flux2-vae.safetensors",
            "VAST-AI/TripoSplat",
            "vae/flux2-vae.safetensors",
        ),
    ]
    if not no_bg:
        _REQUIRED.append(
            (
                "background_removal",
                "birefnet.safetensors",
                "Comfy-Org/BiRefNet",
                "background_removal/birefnet.safetensors",
            ),
        )
    for folder_name, filename, repo_id, hf_filename in _REQUIRED:
        if folder_paths_mod.get_full_path(folder_name, filename) is not None:
            continue
        paths = folder_paths_mod.get_folder_paths(folder_name)
        if not paths:
            print(
                f"{_TAG} WARNING: No folder registered for '{folder_name}'; cannot download {filename}.",
                file=sys.stderr,
            )
            continue
        try:
            _hf_download(repo_id, hf_filename, paths[0])
        except Exception as exc:
            raise RuntimeError(
                f"{_TAG} Failed to download '{filename}' from {repo_id}: {exc}"
            ) from exc


def main():
    parser = argparse.ArgumentParser(
        description="TripoSplat inference (subprocess path)"
    )
    parser.add_argument("--image", required=True, help="Input image path")
    parser.add_argument("--output", required=True, help="Output file path")
    parser.add_argument("--output_format", default="ply", choices=["ply", "splat"])
    parser.add_argument("--num_gaussians", type=int, default=262144)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--no_bg_removal", action="store_true")
    args = parser.parse_args()

    # BuildPythonPsi sets cwd to dlbackend/comfy/ so ComfyUI modules are importable.
    comfy_root = os.getcwd()
    if comfy_root not in sys.path:
        sys.path.insert(0, comfy_root)

    try:
        import nodes  # noqa: F401
        import folder_paths  # noqa: F401
    except ImportError as exc:
        print(f"{_TAG} Cannot import ComfyUI modules: {exc}", file=sys.stderr)
        print(
            f"{_TAG} Ensure this script runs with the ComfyUI Python executable "
            "and the working directory is dlbackend/comfy/.",
            file=sys.stderr,
        )
        sys.exit(1)

    NM = nodes.NODE_CLASS_MAPPINGS

    # Download any missing model weights before attempting to load them.
    _ensure_models(folder_paths, no_bg=args.no_bg_removal)

    required_nodes = [
        "UNETLoader",
        "CLIPVisionLoader",
        "VAELoader",
        "KSampler",
        "TripoSplatConditioning",
        "TripoSplatPreprocessImage",
        "VAEDecodeTripoSplat",
    ]
    missing = [n for n in required_nodes if n not in NM]
    if missing:
        print(
            f"{_TAG} Missing required ComfyUI nodes: {missing}. "
            "Update ComfyUI to v0.22.0 or later.",
            file=sys.stderr,
        )
        sys.exit(1)

    def _call(node_name, *a):
        cls = NM[node_name]
        inst = cls()
        return getattr(inst, inst.FUNCTION)(*a)

    import numpy as np
    import torch
    from PIL import Image

    # Load image as [1, H, W, 3] float32 tensor
    img = Image.open(args.image).convert("RGB")
    img_np = np.array(img).astype(np.float32) / 255.0
    image = torch.from_numpy(img_np).unsqueeze(0)
    h, w = image.shape[1], image.shape[2]
    mask = torch.ones((1, h, w), dtype=torch.float32)

    _UNET = "triposplat_fp16.safetensors"
    _CLIP = "dino_v3_vit_h.safetensors"
    _SVAE = "triposplat_vae_decoder_fp16.safetensors"
    _FVAE = "flux2-vae.safetensors"
    _BGM = "birefnet.safetensors"

    print(f"{_TAG} Loading models...")
    (model,) = _call("UNETLoader", _UNET, "default")
    (clip_vision,) = _call("CLIPVisionLoader", _CLIP)
    (splat_vae,) = _call("VAELoader", _SVAE)
    (flux2_vae,) = _call("VAELoader", _FVAE)

    if not args.no_bg_removal:
        bg_path = folder_paths.get_full_path("background_removal", _BGM)
        if bg_path:
            try:
                from comfy.bg_removal_model import load as _load_bg_model
                print(f"{_TAG} Removing background...")
                bg_obj = _load_bg_model(bg_path)
                if bg_obj is None:
                    raise RuntimeError("BiRefNet model file is invalid or unrecognised.")
                # encode_image returns (B, H, W) foreground alpha matte in [0, 1]
                mask = bg_obj.encode_image(image)
                print(f"{_TAG} Background removal complete.")
            except Exception as exc:
                print(
                    f"{_TAG} Background removal failed (continuing): {exc}",
                    file=sys.stderr,
                )
        else:
            print(f"{_TAG} BiRefNet not found in background_removal/; skipping.")

    print(f"{_TAG} Preprocessing...")
    (preprocessed,) = _call("TripoSplatPreprocessImage", image, mask, 1, 1024)

    print(f"{_TAG} Conditioning...")
    positive, negative, latent = _call(
        "TripoSplatConditioning", clip_vision, flux2_vae, preprocessed
    )

    print(f"{_TAG} Sampling (seed={args.seed}, num_gaussians={args.num_gaussians})...")
    (latent_out,) = _call(
        "KSampler",
        model,
        args.seed,
        20,
        3.0,
        "dpmpp_2m",
        "simple",
        positive,
        negative,
        latent,
        1.0,
    )

    print(f"{_TAG} Decoding SPLAT...")
    # VAEDecodeTripoSplat(samples, vae, num_gaussians, seed)
    (splat,) = _call("VAEDecodeTripoSplat", latent_out, splat_vae, args.num_gaussians, args.seed)

    # Serialise
    output_format = args.output_format
    ply_path = args.output if output_format == "ply" else args.output + ".ply_tmp"
    saved = False

    if "SplatToFile3D" in NM:
        try:
            result = _call("SplatToFile3D", splat, "ply")
            if isinstance(result, dict) and "ui" in result:
                entries = result["ui"].get("model_3d", [])
                if entries:
                    src = os.path.join(
                        folder_paths.get_output_directory(),
                        entries[0].get("subfolder", "3d"),
                        entries[0]["filename"],
                    )
                    if os.path.exists(src):
                        shutil.copy2(src, ply_path)
                        saved = True
                        print(f"{_TAG} Saved via SplatToFile3D → {ply_path}")
        except Exception as exc:
            print(
                f"{_TAG} SplatToFile3D failed ({exc}); using manual PLY writer.",
                file=sys.stderr,
            )

    if not saved:
        _write_ply_from_splat(splat, ply_path)

    if output_format == "splat":
        ext_dir = os.path.dirname(os.path.abspath(__file__))
        convert_script = os.path.join(ext_dir, "run_convert.py")
        r = subprocess.run(
            [sys.executable, "-s", convert_script, ply_path, args.output],
            capture_output=True,
            text=True,
        )
        try:
            os.remove(ply_path)
        except OSError:
            pass
        if r.returncode != 0:
            print(
                f"{_TAG} PLY→splat conversion failed: {r.stderr.strip()}",
                file=sys.stderr,
            )
            sys.exit(1)

    print(f"{_TAG} Done → {args.output}")


if __name__ == "__main__":
    main()
