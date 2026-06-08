# SwarmUI-SharpSplat

A [SwarmUI](https://github.com/mcmonkeyprojects/SwarmUI) extension that turns images into 3D Gaussian Splats directly inside the browser.

Three reconstruction models are supported:

- **ml-sharp** *(default)* — Apple's monocular 3DGS model. Takes a **single image** and produces a Gaussian Splat in seconds.
- **VGGT** — Facebook's [Visual Geometry Grounded Transformer](https://github.com/facebookresearch/vggt) (CVPR 2025 Best Paper). Works with a **single image or multiple images** of the same scene from different angles; more views produce a denser, more accurate point cloud.
- **InstantSplat** — NVIDIA's [InstantSplat](https://github.com/NVlabs/InstantSplat). Takes **multiple images** and uses MASt3R geometry initialisation to produce a coloured point cloud.

> **Note:** Both VGGT and InstantSplat output geometry-initialised point clouds represented as Gaussians with fixed scale and opacity — they are not the result of a full 3DGS training optimisation loop. Results are usable for previewing and exporting but will not match the quality of a dedicated 3DGS training pipeline.

Results are saved as `.ply` (default) or `.splat` and rendered interactively in a dedicated **Splat Viewer** tab powered by [GaussianSplats3D](https://github.com/mkkellogg/GaussianSplats3D/).

---

## How It Works

```
Single image (ml-sharp)      1+ images (VGGT)     2+ images (InstantSplat)
        │                          │                        │
        ▼                          ▼                        ▼
[Generate 3D Splat button]    [Splat Viewer → drop images & select model]
        │                          │                        │
        └──────────────┬───────────┴────────────────────────┘
                       ▼  (base64 → server)
              SharpSplat API (C#)
                       │
           ┌───────────┼───────────┐
           ▼           ▼           ▼
        ml-sharp      VGGT     InstantSplat
     (single img)  (1+ imgs)   (2+ imgs, MASt3R)
           │           │           │
           └───────────┴───────────┘
                       ▼
                  .ply output
                       │
                 [if format = splat]
                       ▼
                  ply2splat → .splat
                  saved to Output/{user}/splats/
                       │
                       ▼
            Splat Viewer tab (WebGL)
```

---

## Requirements

- SwarmUI with a working ComfyUI backend (provides the Python environment).
- An NVIDIA GPU is strongly recommended for both models.
- Internet access on first use to download model weights and install Python dependencies.

Python dependencies are installed automatically on first use:

| Package | Purpose |
|---|---|
| [ml-sharp](https://github.com/apple/ml-sharp) | Monocular 3DGS reconstruction (single image) |
| [VGGT](https://github.com/facebookresearch/vggt) | Multi-view 3D reconstruction |
| [huggingface_hub](https://github.com/huggingface/huggingface_hub) | Downloads VGGT model weights (~1 GB, first run only) |
| [InstantSplat](https://github.com/NVlabs/InstantSplat) | MASt3R-based multi-view reconstruction (cloned from GitHub on first use, ~1.2 GB checkpoint downloaded automatically) |
| [ply2splat](https://github.com/bastikohn/ply2splat) | PLY → `.splat` conversion (only needed when output format is `.splat`) |

---

## Installation

1. In SwarmUI, go to **Server → Extensions**.
2. Click **Install Extension** and provide this repository's URL.
3. Restart SwarmUI.

Or clone manually into `src/Extensions/`:

```sh
cd src/Extensions
git clone https://github.com/GlenCarpenter/SwarmUI-SharpSplat
```

---

## Usage

### Generating a splat from a single image (ml-sharp)

1. Generate any image in the **Generate** tab.
2. Click **Generate 3D Splat** in the image button bar.
3. Wait for inference (30–120 seconds depending on GPU).
4. The **Splat Viewer** tab opens automatically with the result loaded.

> **Note:** The **Generate 3D Splat** button in the image viewer always uses ml-sharp, regardless of the reconstruction model selected in the Splat Viewer settings. VGGT performs poorly with single images, and InstantSplat require multiple images. Both models must be used from the Splat Viewer tab directly.

You can also drop or browse to an image in the **Splat Viewer** sidebar directly.

### Generating a splat from multiple images (VGGT)

VGGT can work from a **single image** but produces significantly better results with multiple photos of the same subject taken from different angles (like a photogrammetry capture).

1. Open the **Splat Viewer** tab.
2. In **Settings**, change **Reconstruction model** to **VGGT**.
3. The dropzone in the **Input Image** section will now accept multiple files.
4. Drop all your images onto the dropzone, or click **Browse** to select them.  
   Each added image appears as a thumbnail — click **×** on a thumbnail to remove it.
5. Click **Generate Splat**.
6. VGGT inference runs through the ComfyUI backend (VRAM-managed like normal generations), falling back to a direct subprocess if no ComfyUI backend is available.

**Tips for best results:**
- Use 5–20 overlapping photos that cover the subject from many angles.
- Keep consistent lighting across shots.
- Avoid motion blur and reflective surfaces.
- Images are resized to 518 × 518 before inference. If your images are not square, enable **Pad images to square** in Settings (see below) to preserve the full frame.

### Generating a splat from multiple images (InstantSplat)

InstantSplat uses NVIDIA's MASt3R geometry initialisation pipeline and **requires at least 2 images**. On first use it clones the InstantSplat repository and downloads a ~1.2 GB MASt3R checkpoint automatically.

1. Open the **Splat Viewer** tab.
2. In **Settings**, change **Reconstruction model** to **InstantSplat**.
3. The dropzone in the **Input Image** section will accept multiple files.
4. Drop at least 2 images onto the dropzone, or click **Browse** to select them.  
   Each added image appears as a thumbnail — click **×** on a thumbnail to remove it.
5. Click **Generate Splat**.
6. Inference runs through the ComfyUI backend, falling back to a direct subprocess if no ComfyUI backend is available.

**Tips for best results:**
- Provide at least 2–3 overlapping images; more views improve geometry.
- Keep consistent lighting and avoid motion blur.
- Enable **Pad images to square** in Settings if your images are not square.

### Settings

Open **Settings** in the Splat Viewer sidebar to configure:

| Setting | Description |
|---|---|
| **Open in viewer after generation** | Automatically navigate to the Splat Viewer tab when a splat finishes. |
| **Reconstruction model** | `ml-sharp` (single image, fast), `VGGT` (multiple images, denser point cloud), or `InstantSplat` (multiple images, MASt3R point cloud). |
| **Pad images to square** | *(VGGT / InstantSplat)* Resize each input image to fit within a square and pad with neutral grey rather than centre-cropping. Useful when your source images are landscape or portrait. Low-confidence grey border splats are filtered out automatically. |
| **Output format** | `PLY` (default, no conversion) or `SPLAT` (compact binary, requires `ply2splat`). |
| **Generate Repair Prompt button** | Shows the **Generate Repair Prompt** button in the Export Canvas section. Intended for use with the ml-sharp repair LoRA — see below. Off by default. |

All settings are remembered between sessions.

### Automatic generation with the `<sharpsplat>` prompt tag

Add `<sharpsplat>` anywhere in your prompt to automatically generate a splat from every image produced by that generation, without clicking the button manually.

```
a photo of a red apple on a wooden table <sharpsplat>
```

- The tag is stripped before it reaches the model — it has no effect on image content.
- Splat generation runs as a node inside the same ComfyUI job as the image.
- Batch generations produce one splat per image.
- This tag always uses **ml-sharp** (single-image mode).

The tag is available in the prompt autocomplete — type `<sharpsplat` to see it suggested.

### Viewing previous splats

1. Click the **Splat Viewer** top-level tab.
2. Previously generated `.ply` and `.splat` files are listed in the left sidebar, newest first.
3. Click any entry to load it into the viewer.
4. Use **↺ Refresh** to update the list after generating new splats.

### Exporting the canvas

The **Export Canvas** section in the Splat Viewer sidebar lets you capture the current rendered frame as a PNG.

1. Load a splat and position the camera as desired.
2. Open **Export Canvas** in the sidebar and click **Export Canvas**.
3. Choose a crop ratio from the **Resolution** dropdown:
   - **None (Full)** — captures the entire canvas at its current resolution.
   - **Aspect ratio presets** (1:1, 4:3, 16:9, etc.) — the largest centered crop of that ratio.
   - **Custom** — enter your own width and height; the largest centered crop matching that ratio is used.
4. A blue overlay on the canvas shows the region that will be captured.
5. Click **Save to Outputs** to save the PNG to `Output/local/splats_export/` with a filename of `splatname_timestamp.png`, or **Download** to download it directly to your browser's download folder.
6. Click **Cancel** to dismiss without exporting.

### Generating a repair prompt (ml-sharp)

The **Generate Repair Prompt** button produces a prompt pre-filled with the current camera movement delta, designed for use with the [flux2-klein9b-lora-mlsharp-3d-repair](https://huggingface.co/cyrildiagne/flux2-klein9b-lora-mlsharp-3d-repair) LoRA. The workflow is:

1. Generate a splat from a single image using **ml-sharp**.
2. Export the initial view as a PNG — this becomes **image 1** (the reference).
3. Orbit to the angle you want repaired, then export again — this becomes **image 2**.
4. Click **Generate Repair Prompt**. The prompt is copied to your clipboard with the camera movement encoded as JSON.
5. Use the copied prompt together with the two exported images and the repair LoRA to inpaint/repair the missing or distorted areas of the novel view.

The prompt takes the form:

```
Referring to the scene in image 1, restore the perspective of the scene in image 2. Repair the perspective and missing areas. The camera has moved by: {"x":0,"y":0,"z":0,"pitch":0,"yaw":0,"roll":0}
```

Position values (`x`, `y`, `z`) are world-space translation deltas relative to the initial camera position at scene load. Rotation values (`pitch`, `yaw`, `roll`) are in degrees.

> **Note:** This feature is designed exclusively for **ml-sharp** splats. VGGT and InstantSplat produce multi-view reconstructions with different geometry characteristics that the repair LoRA was not trained for.

This button is hidden by default. Enable it in **Settings → Generate Repair Prompt button**.

### Viewer controls

| Action | Control |
|---|---|
| Orbit | Left-click + drag |
| Zoom | Scroll wheel |
| Pan | Right-click + drag |

---

## Roadmap

- Export `PLY` as `SPLAT` or `KSPLAT`
- Export `SPLAT` as `KSPLAT`

