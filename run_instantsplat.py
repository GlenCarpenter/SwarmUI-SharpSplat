"""
run_instantsplat.py — MASt3R geometry initialisation wrapper for SwarmUI SharpSplat.

Reads one or more images from --image_dir, runs MASt3R/DUSt3R geometry
initialisation (the first stage of InstantSplat), and writes a coloured point
cloud PLY file to --output_dir/points.ply.

No CUDA submodule compilation (simple-knn, diff-gaussian-rasterization, etc.)
is required — this wrapper deliberately skips the 3DGS training step so that
it works reliably inside ComfyUI's embedded Python environment on any platform.

On first run the script clones the InstantSplat repository into
<extension_dir>/instantsplat/ and downloads the ~1.2 GB MASt3R checkpoint.

Usage:
    python -s run_instantsplat.py --image_dir /tmp/images --output_dir /tmp/output
"""

import argparse
import os
import subprocess
import sys


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_INSTANTSPLAT_DIR = os.path.join(_SCRIPT_DIR, "instantsplat")
_CKPT_DIR = os.path.join(_INSTANTSPLAT_DIR, "mast3r", "checkpoints")
_CKPT_PATH = os.path.join(
    _CKPT_DIR,
    "MASt3R_ViTLarge_BaseDecoder_512_catmlpdpt_metric.pth",
)
_CKPT_URL = (
    "https://download.europe.naverlabs.com/ComputerVision/MASt3R/"
    "MASt3R_ViTLarge_BaseDecoder_512_catmlpdpt_metric.pth"
)
_REPO_URL = "https://github.com/NVlabs/InstantSplat.git"

# Import the shared scientific-stack pin helper from the extension root.
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)
from pinned_stack import ensure_pinned_scientific_stack, pip_install  # noqa: E402

# Sentinel written after a successful pip install so we do not retry on every run.
_DEPS_DONE = os.path.join(_SCRIPT_DIR, ".instantsplat_deps_installed")


# ---------------------------------------------------------------------------
# First-time setup helpers
# ---------------------------------------------------------------------------

def _clone_repo():
    """Clone the InstantSplat repository with all submodules."""
    print("InstantSplat: Cloning repository (first-time setup, this may take a while)...")
    ret = subprocess.run(
        ["git", "clone", "--recursive", _REPO_URL, _INSTANTSPLAT_DIR],
        check=False,
    )
    if ret.returncode != 0:
        print("ERROR: git clone failed — is git installed?", file=sys.stderr)
        sys.exit(ret.returncode)
    print("InstantSplat: Repository cloned.")


def _download_checkpoint():
    """Download the MASt3R checkpoint (~1.2 GB)."""
    os.makedirs(_CKPT_DIR, exist_ok=True)
    print("InstantSplat: Downloading MASt3R checkpoint (~1.2 GB, first-time setup)...")
    downloaded = False
    try:
        ret = subprocess.run(
            ["wget", "-q", "--show-progress", "-O", _CKPT_PATH, _CKPT_URL],
            check=False,
        )
        if ret.returncode == 0:
            downloaded = True
    except FileNotFoundError:
        pass

    if not downloaded:
        try:
            import urllib.request
            urllib.request.urlretrieve(_CKPT_URL, _CKPT_PATH)
            downloaded = True
        except Exception as exc:
            print(f"ERROR: Failed to download MASt3R checkpoint: {exc}", file=sys.stderr)
            sys.exit(1)

    print("InstantSplat: Checkpoint downloaded.")


def _install_deps():
    """Install pip-installable requirements (torch/torchvision skipped — already in ComfyUI).

    CUDA submodules (simple-knn, diff-gaussian-rasterization, fused-ssim) are
    intentionally NOT installed because this wrapper skips the 3DGS training step
    that requires them, making this approach work in any embedded Python.
    """
    req_path = os.path.join(_INSTANTSPLAT_DIR, "requirements.txt")
    if not os.path.isfile(req_path):
        print("InstantSplat: No requirements.txt found, skipping pip install.")
        return

    print("InstantSplat: Installing Python requirements (skipping torch/torchvision/scientific-stack)...")

    # Keep scipy and cv2 consumers in this repo aligned with SwarmUI's pinned stack.
    ensure_pinned_scientific_stack(upgrade=True)

    _SKIP_PKGS = {
        "torch", "torchvision", "torchaudio",
        "numpy", "scipy", "opencv-python", "opencv-python-headless",
    }
    filtered_lines = []
    with open(req_path, "r", encoding="utf-8") as fh:
        for line in fh:
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                filtered_lines.append(line)
                continue
            pkg_name = (
                stripped
                .split(">=")[0].split("<=")[0].split("==")[0]
                .split("!=")[0].split("[")[0].strip().lower()
            )
            if pkg_name in _SKIP_PKGS:
                print(f"InstantSplat: Skipping '{stripped}' (already in embedded env)")
                continue
            filtered_lines.append(line)

    import tempfile as _tf
    with _tf.NamedTemporaryFile(mode="w", suffix=".txt", delete=False, encoding="utf-8") as tmp:
        tmp.writelines(filtered_lines)
        filtered_req = tmp.name

    try:
        pip_install(requirements=filtered_req)
        ensure_pinned_scientific_stack(upgrade=True)
    finally:
        os.unlink(filtered_req)

    print("InstantSplat: Dependencies installed.")


def ensure_setup():
    """Clone repo, install deps, and download checkpoint as needed."""
    if not os.path.isdir(_INSTANTSPLAT_DIR):
        _clone_repo()
        _install_deps()
        open(_DEPS_DONE, "w").close()
    elif not os.path.isfile(_DEPS_DONE):
        print("InstantSplat: Re-running dependency installation...")
        _install_deps()
        open(_DEPS_DONE, "w").close()

    if not os.path.isfile(_CKPT_PATH):
        _download_checkpoint()


# SH degree-0 coefficient (DC component).
_SH_C0 = 0.28209479177387814


# ---------------------------------------------------------------------------
# PLY writer — full Gaussian splat format compatible with the splat viewer
# ---------------------------------------------------------------------------

def _write_ply(path, xyz, rgb):
    """Write a binary Gaussian splat PLY file compatible with the splat viewer.

    Each input point becomes a tiny isotropic Gaussian splat with colour
    derived from per-point RGB (converted to SH DC coefficients), a small
    fixed scale, high opacity, and identity rotation.

    Args:
        path: Output file path.
        xyz:  (N, 3) float32 array of point positions.
        rgb:  (N, 3) uint8 array of point colours (0-255).
    """
    import numpy as np

    n = xyz.shape[0]

    rgb_f = rgb.astype(np.float32) / 255.0
    f_dc = (rgb_f - 0.5) / _SH_C0          # (N, 3)

    normals  = np.zeros((n, 3),  dtype=np.float32)
    f_rest   = np.zeros((n, 45), dtype=np.float32)
    opacity  = np.full((n, 1),   2.944,  dtype=np.float32)  # logit(0.95)
    log_scale = np.full((n, 3), -5.8,   dtype=np.float32)   # log(~0.003)
    rot      = np.zeros((n, 4),  dtype=np.float32)
    rot[:, 0] = 1.0  # identity quaternion w=1

    data = np.concatenate(
        [xyz.astype(np.float32), normals, f_dc, f_rest, opacity, log_scale, rot],
        axis=1,
    )  # (N, 62) float32

    props = ["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2"]
    props += [f"f_rest_{i}" for i in range(45)]
    props += ["opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]

    header = (
        ["ply", "format binary_little_endian 1.0", f"element vertex {n}"]
        + [f"property float {p}" for p in props]
        + ["end_header"]
    )
    header_bytes = ("\n".join(header) + "\n").encode("ascii")

    with open(path, "wb") as fh:
        fh.write(header_bytes)
        fh.write(data.tobytes())


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args():
    parser = argparse.ArgumentParser(
        description="InstantSplat MASt3R geometry init for SharpSplat"
    )
    parser.add_argument(
        "--image_dir", required=True, help="Directory containing input images"
    )
    parser.add_argument(
        "--output_dir", required=True, help="Directory to write points.ply into"
    )
    parser.add_argument(
        "--n_views",
        type=int,
        default=None,
        help="Number of views to use (default: all images in image_dir)",
    )
    parser.add_argument(
        "--conf_percentile",
        type=float,
        default=10.0,
        help="Remove the lowest N%% confidence points (default: 10.0)",
    )
    parser.add_argument(
        "--image_size",
        type=int,
        default=512,
        help="Long-side image resize for MASt3R (default: 512)",
    )
    parser.add_argument(
        "--pad_to_square",
        action="store_true",
        help="Pad each input image to a square with grey bars before processing",
    )
    return parser.parse_args()


def pad_images_to_square(image_paths, out_dir):
    """Pad images to square with mid-grey and write to out_dir as PNGs."""
    from PIL import Image as _Image
    os.makedirs(out_dir, exist_ok=True)
    out_paths = []
    for idx, src in enumerate(image_paths):
        img = _Image.open(src).convert("RGB")
        w, h = img.size
        side = max(w, h)
        padded = _Image.new("RGB", (side, side), (128, 128, 128))
        padded.paste(img, ((side - w) // 2, (side - h) // 2))
        out_path = os.path.join(out_dir, f"padded_{idx:04d}.png")
        padded.save(out_path, "PNG")
        out_paths.append(out_path)
    return out_paths


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    args = parse_args()

    ensure_setup()

    # Add InstantSplat repo to the Python path so its modules are importable.
    if _INSTANTSPLAT_DIR not in sys.path:
        sys.path.insert(0, _INSTANTSPLAT_DIR)

    # Silence the noisy icecream debug print that init_geo.py does at import time.
    try:
        import icecream
        icecream.ic.disable()
    except ImportError:
        pass

    import numpy as np
    import torch

    # ------------------------------------------------------------------
    # Collect and optionally pad input images
    # ------------------------------------------------------------------
    extensions = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tiff", ".tif"}
    image_files = sorted(
        os.path.join(args.image_dir, f)
        for f in os.listdir(args.image_dir)
        if os.path.splitext(f)[1].lower() in extensions
    )
    if not image_files:
        print(f"ERROR: No image files found in '{args.image_dir}'", file=sys.stderr)
        sys.exit(1)

    if args.pad_to_square:
        pad_dir = os.path.join(args.output_dir, "_padded")
        print("InstantSplat: Padding images to square...")
        image_files = pad_images_to_square(image_files, pad_dir)

    n_views = args.n_views if args.n_views else len(image_files)
    n_views = min(n_views, len(image_files))
    image_files = image_files[:n_views]
    print(f"InstantSplat: Using {n_views} view(s).")

    if n_views < 2:
        print(
            "ERROR: InstantSplat requires at least 2 input images to compute view pairs. "
            "Please provide multiple images.",
            file=sys.stderr,
        )
        sys.exit(1)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"InstantSplat: Running on {device}.")

    # ------------------------------------------------------------------
    # Load MASt3R model
    # ------------------------------------------------------------------
    # PyTorch 2.6 changed weights_only default to True, which breaks the
    # MASt3R checkpoint (it contains argparse.Namespace objects).  Patch
    # torch.load to always pass weights_only=False for this process so we
    # don't have to modify upstream repo files.
    _original_torch_load = torch.load
    def _torch_load_weights_only_false(*args, **kwargs):
        kwargs.setdefault('weights_only', False)
        return _original_torch_load(*args, **kwargs)
    torch.load = _torch_load_weights_only_false

    print("InstantSplat: Loading MASt3R model...")
    from mast3r.model import AsymmetricMASt3R
    model = AsymmetricMASt3R.from_pretrained(_CKPT_PATH).to(device)
    model.eval()

    # ------------------------------------------------------------------
    # Load images for DUSt3R (uses its own resize/normalise pipeline)
    # ------------------------------------------------------------------
    from dust3r.utils.image import load_images as dust3r_load_images
    images = dust3r_load_images(image_files, size=args.image_size, verbose=True)

    # ------------------------------------------------------------------
    # Inference: paired forward passes
    # ------------------------------------------------------------------
    from dust3r.image_pairs import make_pairs
    from dust3r.inference import inference
    pairs = make_pairs(images, scene_graph="complete", prefilter=None, symmetrize=True)
    print(f"InstantSplat: Running inference on {len(pairs)} pair(s)...")
    with torch.no_grad():
        output = inference(pairs, model, device, batch_size=1, verbose=True)

    # ------------------------------------------------------------------
    # Global alignment (PointCloudOptimizer)
    # ------------------------------------------------------------------
    from dust3r.cloud_opt import global_aligner, GlobalAlignerMode
    from dust3r.utils.device import to_numpy
    print("InstantSplat: Running global alignment...")
    scene = global_aligner(
        output,
        device=device,
        mode=GlobalAlignerMode.PointCloudOptimizer,
    )
    scene.compute_global_alignment(
        init="mst",
        niter=300,
        schedule="cosine",
        lr=0.01,
        focal_avg=True,
    )

    # ------------------------------------------------------------------
    # Extract point cloud and colours
    # ------------------------------------------------------------------
    pts3d = to_numpy(scene.get_pts3d())      # list of (H, W, 3)
    imgs = scene.imgs                         # list of (H, W, 3) in [0, 1] — may have different H/W
    confs = [
        param.detach().cpu().numpy() for param in scene.im_conf
    ]                                         # list of (H, W)

    pts_flat = np.concatenate([p.reshape(-1, 3) for p in pts3d], axis=0).astype(np.float32)
    col_flat = (np.concatenate([img.reshape(-1, 3) for img in imgs], axis=0) * 255).clip(0, 255).astype(np.uint8)
    conf_flat = np.concatenate([c.reshape(-1) for c in confs])

    # ------------------------------------------------------------------
    # Filter by confidence (remove lowest percentile)
    # ------------------------------------------------------------------
    if args.conf_percentile > 0.0:
        threshold = np.percentile(conf_flat, args.conf_percentile)
        mask = conf_flat >= threshold
        pts_flat = pts_flat[mask]
        col_flat = col_flat[mask]
        print(
            f"InstantSplat: Confidence filter kept "
            f"{mask.sum()} / {mask.size} points "
            f"(removed bottom {args.conf_percentile:.1f}%%)."
        )

    # ------------------------------------------------------------------
    # Write PLY
    # ------------------------------------------------------------------
    os.makedirs(args.output_dir, exist_ok=True)
    output_ply = os.path.join(args.output_dir, "points.ply")
    _write_ply(output_ply, pts_flat, col_flat)
    print(f"InstantSplat: Wrote {pts_flat.shape[0]} points to '{output_ply}'.")


if __name__ == "__main__":
    main()
