"""ComfyUI custom node for TripoSplat-based Gaussian splat generation.

Wraps the full TripoSplat pipeline (image preprocessing → conditioning →
KSampler → VAE decode) using ComfyUI's native TripoSplat nodes (comfy-core
≥ v0.22.0). The SPLAT output is serialised to a .ply or .splat file at
output_path, following the same conventions as SharpSplatNode.py.

The C# side (SharpSplatAPI.TripoSplatGenerateSplatViaComfy) is responsible for:
  - determining the absolute output_path before submitting the workflow
  - verifying the file exists after the workflow completes
  - returning the URL to the browser

Model weights required in the ComfyUI models directory:
  diffusion_models/triposplat_fp16.safetensors
  clip_vision/dino_v3_vit_h.safetensors
  vae/triposplat_vae_decoder_fp16.safetensors
  vae/flux2-vae.safetensors
  background_removal/birefnet.safetensors  (optional, for remove_background)
"""

import os
import shutil
import subprocess
import sys

import folder_paths

_TAG = "[TripoSplat]"
_EXT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

_UNET_NAME = "triposplat_fp16.safetensors"
_CLIP_NAME = "dino_v3_vit_h.safetensors"
_SPLAT_VAE = "triposplat_vae_decoder_fp16.safetensors"
_FLUX2_VAE = "flux2-vae.safetensors"
_BG_MODEL  = "birefnet.safetensors"

# Models that must be present before inference can run.
# Each entry: (folder_name, filename, hf_repo_id, hf_filename)
_REQUIRED_MODELS = [
    ("diffusion_models", _UNET_NAME,  "VAST-AI/TripoSplat", "diffusion_models/triposplat_fp16.safetensors"),
    ("clip_vision",      _CLIP_NAME,  "VAST-AI/TripoSplat", "clip_vision/dino_v3_vit_h.safetensors"),
    ("vae",              _SPLAT_VAE,  "VAST-AI/TripoSplat", "vae/triposplat_vae_decoder_fp16.safetensors"),
    ("vae",              _FLUX2_VAE,  "VAST-AI/TripoSplat", "vae/flux2-vae.safetensors"),
]

# Optional model — background removal. Downloaded on first use if absent.
_OPTIONAL_MODELS = [
    ("background_removal", _BG_MODEL, "Comfy-Org/BiRefNet", "background_removal/birefnet.safetensors"),
]


def _hf_download(repo_id: str, hf_filename: str, local_dir: str) -> str:
    """Download a single file from HuggingFace Hub into local_dir.

    Downloads to a temporary directory first, then moves only the bare file
    into local_dir to avoid hf_hub_download recreating the repo subdirectory
    structure inside local_dir.

    Returns the absolute path of the downloaded file.
    Installs huggingface_hub via pip if not already available.
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
    return final_path


def _ensure_models(include_optional: bool = False) -> None:
    """Download any missing TripoSplat model weights from HuggingFace.

    Uses folder_paths to resolve the first registered path for each model
    type, so the files land exactly where ComfyUI will find them.
    """
    targets = list(_REQUIRED_MODELS)
    if include_optional:
        targets += _OPTIONAL_MODELS

    for folder_name, filename, repo_id, hf_filename in targets:
        if folder_paths.get_full_path(folder_name, filename) is not None:
            continue  # already present

        paths = folder_paths.get_folder_paths(folder_name)
        if not paths:
            print(
                f"{_TAG} WARNING: No folder registered for '{folder_name}'; "
                f"cannot download {filename}.",
                file=sys.stderr,
            )
            continue

        target_dir = paths[0]
        try:
            _hf_download(repo_id, hf_filename, target_dir)
        except Exception as exc:
            raise RuntimeError(
                f"{_TAG} Failed to download '{filename}' from {repo_id}: {exc}"
            ) from exc


def _call_node(nm, node_name, *args):
    """Instantiate a node from NODE_CLASS_MAPPINGS and call its FUNCTION method."""
    if node_name not in nm:
        raise RuntimeError(
            f"{_TAG} Node '{node_name}' is not in NODE_CLASS_MAPPINGS. "
            "Please update ComfyUI to v0.22.0 or later."
        )
    cls = nm[node_name]
    instance = cls()
    return getattr(instance, instance.FUNCTION)(*args)


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


class TripoSplatGenerate:
    """Generates a 3D Gaussian Splat (.ply or .splat) from a single input image
    using the TripoSplat pipeline (VAST-AI/TripoSplat)."""

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "images": ("IMAGE",),
                "output_path": ("STRING", {"default": ""}),
                "output_format": (["ply", "splat"], {"default": "ply"}),
                "num_gaussians": (
                    "INT",
                    {"default": 262144, "min": 1024, "max": 262144, "step": 32},
                ),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFF}),
                "remove_background": ("BOOLEAN", {"default": True}),
            }
        }

    CATEGORY = "SharpSplat"
    RETURN_TYPES = ()
    FUNCTION = "generate_splat"
    OUTPUT_NODE = True
    DESCRIPTION = (
        "Generates a 3D Gaussian Splat from a single input image using TripoSplat "
        "(VAST-AI/TripoSplat). Requires ComfyUI ≥ v0.22.0 and model weights in "
        "the ComfyUI models directory: "
        "diffusion_models/triposplat_fp16.safetensors, "
        "clip_vision/dino_v3_vit_h.safetensors, "
        "vae/triposplat_vae_decoder_fp16.safetensors, "
        "vae/flux2-vae.safetensors. "
        "Optional: background_removal/birefnet.safetensors for background removal. "
        "Intended for use with SwarmUI's SharpSplat extension."
    )

    def generate_splat(
        self,
        images,
        output_path,
        output_format="ply",
        num_gaussians=262144,
        seed=0,
        remove_background=True,
    ):
        import torch

        if not output_path:
            raise ValueError(f"{_TAG} output_path must not be empty.")
        if output_format not in ("ply", "splat"):
            output_format = "ply"

        # Download any missing model weights before attempting to load them.
        _ensure_models(include_optional=remove_background)

        import nodes
        NM = nodes.NODE_CLASS_MAPPINGS

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
            raise RuntimeError(
                f"{_TAG} Required ComfyUI nodes not found: {missing}. "
                "Update ComfyUI to v0.22.0 or later."
            )

        # --- Load models ---
        print(f"{_TAG} Loading models...")
        (model,)       = _call_node(NM, "UNETLoader", _UNET_NAME, "default")
        (clip_vision,) = _call_node(NM, "CLIPVisionLoader", _CLIP_NAME)
        (splat_vae,)   = _call_node(NM, "VAELoader", _SPLAT_VAE)
        (flux2_vae,)   = _call_node(NM, "VAELoader", _FLUX2_VAE)

        # --- Background removal (optional) ---
        image = images[:1]  # single image [1, H, W, 3]
        h, w  = image.shape[1], image.shape[2]
        mask  = torch.ones((1, h, w), device=image.device, dtype=torch.float32)

        if (
            remove_background
            and "LoadBackgroundRemovalModel" in NM
            and "RemoveBackground" in NM
        ):
            bg_files = folder_paths.get_filename_list("background_removal")
            if _BG_MODEL in bg_files:
                try:
                    print(f"{_TAG} Removing background via BiRefNet...")
                    (bg_model,) = _call_node(NM, "LoadBackgroundRemovalModel", _BG_MODEL)
                    bg_result   = _call_node(NM, "RemoveBackground", image, bg_model)
                    # RemoveBackground returns (RGBA image, mask) or (image, mask)
                    if isinstance(bg_result, (list, tuple)) and len(bg_result) >= 2:
                        image = bg_result[0]
                        mask  = bg_result[1]
                except Exception as exc:
                    print(f"{_TAG} Background removal failed (continuing without): {exc}")
            else:
                print(f"{_TAG} BiRefNet not found in background_removal/; skipping.")

        # --- Preprocess ---
        print(f"{_TAG} Preprocessing image...")
        # TripoSplatPreprocessImage(image, mask, [scale_factor=1, target_size=1024])
        (preprocessed,) = _call_node(NM, "TripoSplatPreprocessImage", image, mask, 1, 1024)

        # --- Conditioning ---
        print(f"{_TAG} Conditioning...")
        # TripoSplatConditioning(clip_vision, flux2_vae, image) →
        #   (positive, negative, latent)
        positive, negative, latent = _call_node(
            NM, "TripoSplatConditioning", clip_vision, flux2_vae, preprocessed
        )

        # --- Sample ---
        print(f"{_TAG} Sampling (seed={seed}, num_gaussians={num_gaussians})...")
        # KSampler(model, seed, steps, cfg, sampler_name, scheduler,
        #          positive, negative, latent_image, denoise)
        (latent_out,) = _call_node(
            NM, "KSampler",
            model, seed, 20, 3.0, "dpmpp_2m", "simple",
            positive, negative, latent, 1.0,
        )

        # --- Decode ---
        print(f"{_TAG} Decoding SPLAT...")
        # VAEDecodeTripoSplat(samples, vae, num_gaussians, seed)
        (splat,) = _call_node(
            NM, "VAEDecodeTripoSplat", latent_out, splat_vae, num_gaussians, seed
        )

        # --- Serialise ---
        # Try SplatToFile3D with "ply" format first (native, most accurate).
        ply_path = output_path if output_format == "ply" else output_path + ".ply_tmp"
        saved = False

        if "SplatToFile3D" in NM:
            try:
                result = _call_node(NM, "SplatToFile3D", splat, "ply")
                # SplatToFile3D returns (File3D,); File3D.get_bytes() gives the raw PLY bytes.
                file3d = result[0] if isinstance(result, (list, tuple)) else result
                ply_bytes = file3d.get_bytes()
                with open(ply_path, "wb") as fh:
                    fh.write(ply_bytes)
                saved = True
                print(f"{_TAG} Saved via SplatToFile3D → {ply_path}")
            except Exception as exc:
                print(f"{_TAG} SplatToFile3D failed ({exc}); using manual PLY writer.")

        if not saved:
            _write_ply_from_splat(splat, ply_path)

        # Convert PLY → binary .splat if requested
        if output_format == "splat":
            convert_script = os.path.join(_EXT_DIR, "run_convert.py")
            r = subprocess.run(
                [sys.executable, "-s", convert_script, ply_path, output_path],
                capture_output=True,
                text=True,
            )
            try:
                os.remove(ply_path)
            except OSError:
                pass
            if r.returncode != 0:
                raise RuntimeError(
                    f"{_TAG} PLY→splat conversion failed: {r.stderr.strip()}"
                )

        print(f"{_TAG} Complete → {output_path}")
        return ()


NODE_CLASS_MAPPINGS = {
    "TripoSplatGenerate": TripoSplatGenerate,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "TripoSplatGenerate": "TripoSplat Generate (SharpSplat)",
}
