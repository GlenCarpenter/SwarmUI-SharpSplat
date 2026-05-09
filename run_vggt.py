"""
run_vggt.py — VGGT inference wrapper for SwarmUI SharpSplat extension.

Reads one or more images from --image_dir, runs VGGT inference, and writes a
Gaussian splat PLY file (binary little-endian) to --output_dir/points.ply.
The PLY carries the standard 3DGS properties (f_dc, opacity, scale, rot) so
it can be loaded directly by the splat viewer and converted to .splat format.

Usage:
    python -s run_vggt.py --image_dir /tmp/images --output_dir /tmp/output
"""

import argparse
import os
import sys
import numpy as np


def parse_args():
    parser = argparse.ArgumentParser(description="VGGT inference for SharpSplat")
    parser.add_argument(
        "--image_dir", required=True, help="Directory containing input images"
    )
    parser.add_argument(
        "--output_dir", required=True, help="Directory to write points.ply into"
    )
    parser.add_argument(
        "--conf_percentile",
        type=float,
        default=10.0,
        help="Remove the lowest N%% confidence points (default: 10.0)",
    )
    parser.add_argument(
        "--use_point_map",
        action="store_true",
        help="Use world_points output instead of depth-unprojected points",
    )
    parser.add_argument(
        "--pad_to_square",
        action="store_true",
        help="Pad each input image to a square with grey bars before VGGT preprocessing",
    )
    return parser.parse_args()


def load_images(image_dir):
    """Return sorted list of image file paths from the directory."""
    extensions = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tiff", ".tif"}
    paths = sorted(
        p
        for p in (os.path.join(image_dir, f) for f in os.listdir(image_dir))
        if os.path.splitext(p)[1].lower() in extensions
    )
    if not paths:
        raise ValueError(f"No image files found in '{image_dir}'")
    return paths


def pad_images_to_square(image_paths, out_dir):
    """Resize each image so it fits in a square, then pad with mid-grey to fill.

    The padded images are written as PNG files into out_dir.  Returns a new
    sorted list of paths that can be passed to load_and_preprocess_images.

    Padding colour is (128, 128, 128) — neutral grey that VGGT will likely
    assign low confidence to, so those splats are filtered out.

    Args:
        image_paths: List of source image file paths.
        out_dir: Directory to write padded PNG files into.
    Returns:
        List of paths to the padded images, in the same order.
    """
    try:
        from PIL import Image
    except ImportError:
        raise RuntimeError(
            "Pillow is required for --pad_to_square. "
            "Install with: pip install Pillow"
        )
    os.makedirs(out_dir, exist_ok=True)
    out_paths = []
    for idx, src in enumerate(image_paths):
        img = Image.open(src).convert("RGB")
        w, h = img.size
        side = max(w, h)
        padded = Image.new("RGB", (side, side), (128, 128, 128))
        # Center the original image.
        paste_x = (side - w) // 2
        paste_y = (side - h) // 2
        padded.paste(img, (paste_x, paste_y))
        out_path = os.path.join(out_dir, f"padded_{idx:04d}.png")
        padded.save(out_path, "PNG")
        out_paths.append(out_path)
    return out_paths


# SH degree-0 coefficient (DC component).
_SH_C0 = 0.28209479177387814


def write_gaussian_splat_ply(output_path, points, colors):
    """Write a binary Gaussian splat PLY file.

    Each input point becomes a tiny isotropic Gaussian splat with:
      - colour derived from the per-point RGB (converted to SH DC coefficients)
      - a small fixed scale (~0.003 world units)
      - opacity ≈ 0.95 (stored as pre-sigmoid logit)
      - identity rotation quaternion

    The resulting file is compatible with the @mkkellogg/gaussian-splats-3d
    viewer and with the ply2splat converter.

    Args:
        output_path: Destination file path.
        points: (N, 3) float32 XYZ array.
        colors: (N, 3) uint8 RGB array.
    """
    n = len(points)

    # SH DC colour coefficients (f_dc_0..2) from RGB.
    rgb_f = colors.astype(np.float32) / 255.0
    f_dc = (rgb_f - 0.5) / _SH_C0  # (N, 3)

    normals = np.zeros((n, 3), dtype=np.float32)
    f_rest = np.zeros((n, 45), dtype=np.float32)
    opacity = np.full((n, 1), 2.944, dtype=np.float32)  # logit(0.95)
    log_scale = np.full((n, 3), -5.8, dtype=np.float32)  # log(0.003)
    rot = np.zeros((n, 4), dtype=np.float32)
    rot[:, 0] = 1.0  # identity quaternion: w=1, x=y=z=0

    # Property order must match header: x y z nx ny nz f_dc_0..2 f_rest_0..44
    # opacity scale_0..2 rot_0..3  (62 floats per vertex).
    data = np.concatenate(
        [
            points.astype(np.float32),  # 3
            normals,  # 3
            f_dc,  # 3
            f_rest,  # 45
            opacity,  # 1
            log_scale,  # 3
            rot,  # 4
        ],
        axis=1,
    )  # (N, 62) float32, C-contiguous → correct binary layout

    props = ["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2"]
    props += [f"f_rest_{i}" for i in range(45)]
    props += [
        "opacity",
        "scale_0",
        "scale_1",
        "scale_2",
        "rot_0",
        "rot_1",
        "rot_2",
        "rot_3",
    ]

    header_lines = (
        ["ply", "format binary_little_endian 1.0", f"element vertex {n}"]
        + [f"property float {p}" for p in props]
        + ["end_header"]
    )
    header_bytes = ("\n".join(header_lines) + "\n").encode("ascii")

    with open(output_path, "wb") as fh:
        fh.write(header_bytes)
        fh.write(data.tobytes())


def main():
    args = parse_args()

    try:
        import torch
    except ImportError:
        print(
            "ERROR: torch is not available in this Python environment.", file=sys.stderr
        )
        sys.exit(1)

    try:
        from vggt.models.vggt import VGGT
        from vggt.utils.load_fn import load_and_preprocess_images
        from vggt.utils.pose_enc import pose_encoding_to_extri_intri
        from vggt.utils.geometry import unproject_depth_map_to_point_map
    except ImportError as e:
        print(f"ERROR: VGGT package not found: {e}", file=sys.stderr)
        print(
            "Install with: pip install git+https://github.com/facebookresearch/vggt.git",
            file=sys.stderr,
        )
        sys.exit(1)

    image_paths = load_images(args.image_dir)
    print(f"VGGT: loaded {len(image_paths)} image(s) from '{args.image_dir}'")

    if args.pad_to_square:
        pad_dir = os.path.join(args.output_dir, "_padded")
        print("VGGT: padding images to square...")
        image_paths = pad_images_to_square(image_paths, pad_dir)
        print(f"VGGT: padded {len(image_paths)} image(s) to '{pad_dir}'")

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"VGGT: using device={device}")

    if torch.cuda.is_available() and torch.cuda.get_device_capability()[0] >= 8:
        dtype = torch.bfloat16
    else:
        dtype = torch.float16

    print("VGGT: loading model weights (may download ~1 GB on first run)...")
    model = VGGT.from_pretrained("facebook/VGGT-1B").to(device)
    model.eval()
    print("VGGT: model ready")

    images = load_and_preprocess_images(image_paths).to(device)

    # Keep a CPU float copy for colours before the model may modify the tensor.
    images_cpu = images.detach().cpu().float().numpy()
    if images_cpu.ndim == 5:  # (1, S, 3, H, W) — remove batch dim
        images_cpu = images_cpu.squeeze(0)
    # images_cpu: (S, 3, H, W)

    print("VGGT: running inference...")
    with torch.no_grad():
        with torch.amp.autocast(device, dtype=dtype):
            predictions = model(images)

    print("VGGT: decoding camera poses...")
    extrinsic, intrinsic = pose_encoding_to_extri_intri(
        predictions["pose_enc"], images.shape[-2:]
    )

    # Move tensors to CPU numpy, removing batch dimension.
    for key in list(predictions.keys()):
        if isinstance(predictions[key], torch.Tensor):
            predictions[key] = (
                predictions[key].detach().cpu().float().numpy().squeeze(0)
            )

    extrinsic_np = extrinsic.detach().cpu().float().numpy().squeeze(0)  # (S, 3, 4)
    intrinsic_np = intrinsic.detach().cpu().float().numpy().squeeze(0)  # (S, 3, 3)

    if args.use_point_map:
        world_points = predictions["world_points"]  # (S, H, W, 3)
        conf = predictions["world_points_conf"]  # (S, H, W)
    else:
        depth_map = predictions["depth"]  # (S, H, W, 1)
        world_points = unproject_depth_map_to_point_map(
            depth_map, extrinsic_np, intrinsic_np
        )
        conf = predictions["depth_conf"]  # (S, H, W)

    # Derive per-point colours from the (S, 3, H, W) input images.
    colors_f = images_cpu.transpose(0, 2, 3, 1)  # (S, H, W, 3)

    # Flatten to point lists.
    points_flat = world_points.reshape(-1, 3).astype(np.float32)
    colors_flat = (colors_f.reshape(-1, 3) * 255).clip(0, 255).astype(np.uint8)
    conf_flat = conf.reshape(-1)

    # Filter low-confidence points.
    if args.conf_percentile > 0.0:
        threshold = float(np.percentile(conf_flat, args.conf_percentile))
        mask = (conf_flat >= threshold) & (conf_flat > 1e-5)
    else:
        mask = conf_flat > 1e-5

    points_out = points_flat[mask]
    colors_out = colors_flat[mask]
    print(
        f"VGGT: {mask.sum()} / {len(points_flat)} points retained after confidence filtering"
    )

    os.makedirs(args.output_dir, exist_ok=True)
    output_path = os.path.join(args.output_dir, "points.ply")
    write_gaussian_splat_ply(output_path, points_out, colors_out)
    print(f"VGGT: wrote Gaussian splat PLY to '{output_path}'")


if __name__ == "__main__":
    main()
