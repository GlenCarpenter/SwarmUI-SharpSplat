# SwarmUI-SharpSplat

A [SwarmUI](https://github.com/mcmonkeyprojects/SwarmUI) extension that turns any generated image into a 3D Gaussian Splat directly inside the browser.

It uses Apple's [ml-sharp](https://github.com/apple/ml-sharp) to reconstruct a 3D scene from a single image, saving the result as `.ply` by default (or `.splat` if preferred), and renders it interactively in a dedicated **Splat Viewer** tab powered by [GaussianSplats3D](https://github.com/mkkellogg/GaussianSplats3D/).

---

## How It Works

```
Generated image
      │
      ▼
[Generate 3D Splat button]
      │
      ▼  (sends image as base64 to server)
SharpGenerateSplat API (C#)
      │
      ├─► ml-sharp  →  .ply  (3D Gaussian Splat, standard PLY format)
      │
      └─► [if format = splat] ply2splat  →  .splat  (compact 32-bytes-per-splat binary)
                               saved to Output/{user}/splats/
      │
      ▼  (returns /View/... HTTP URL)
Splat Viewer tab (browser)
      │
      └─► GaussianSplats3D  →  interactive WebGL viewer
```

### Step by step

1. **Generate an image** in the SwarmUI Generate tab as normal.
2. Click the **Generate 3D Splat** button that appears on the image.
3. The image is sent to the SwarmUI server. The extension:
   - Writes the image to a temp directory.
   - Runs `sharp predict` via ml-sharp to reconstruct a 3D Gaussian Splat as a `.ply` file.
   - Saves the output to `Output/{user}/splats/` — as `.ply` by default, or converted to `.splat` via `ply2splat` if that format is selected in Settings.
   - Returns the HTTP URL of the saved file.
4. SwarmUI automatically navigates to the **Splat Viewer** tab and loads the result (adjustable in settings).
5. Orbit, zoom, and pan around the scene with the mouse.

Previously generated splats are listed in the sidebar and can be reloaded at any time.


https://github.com/user-attachments/assets/4094c5f1-c789-431d-a99c-53ec3ff7d601


---

## Requirements

- SwarmUI with a working ComfyUI backend (provides the Python environment).
- An NVIDIA GPU is strongly recommended. `ml-sharp` uses PyTorch for inference.
- Internet access on first use to install Python dependencies.

Python dependencies are installed automatically the first time you click **Generate 3D Splat**:

| Package | Purpose |
|---|---|
| [ml-sharp](https://github.com/apple/ml-sharp) | Monocular 3D Gaussian Splat reconstruction |
| [ply2splat](https://github.com/bastikohn/ply2splat) | PLY → `.splat` binary conversion (only required when output format is set to `.splat`) |

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

### Generating a splat

1. Generate any image in the **Generate** tab.
2. Click **Generate 3D Splat** in the image button bar.
3. Wait for inference (30–120 seconds depending on GPU).
4. The **Splat Viewer** tab opens automatically with the result loaded.

### Choosing the output format

In the **Splat Viewer** sidebar, open **Settings** and use the **Output format** dropdown to choose between:

- **`.ply`** *(default)* — Standard Gaussian Splat PLY file. No conversion step; faster to save.
- **`.splat`** — Compact 32-bytes-per-splat binary. Requires the `ply2splat` Python package.

The selection is remembered between sessions.

### Automatic generation with the `<sharpsplat>` prompt tag

Add `<sharpsplat>` anywhere in your prompt to automatically generate a splat file from every image produced by that generation, without clicking the button manually.

```
a photo of a red apple on a wooden table <sharpsplat>
```

- The tag is stripped from the prompt before it reaches the model — it has no effect on image content.
- Splat generation runs as a node inside the same ComfyUI job as the image, so each image waits for its splat to finish before the next image begins.
- Batch generations produce one `.splat` per image.
- Generated splats appear in the **Splat Viewer** sidebar as usual.

The tag is available in the prompt autocomplete — type `<sharpsplat` to see it suggested.

### Viewing previous splats

1. Click the **Splat Viewer** top-level tab.
2. Previously generated `.ply` and `.splat` files are listed in the left sidebar, newest first.
3. Click any entry to load it into the viewer.
4. Use **↺ Refresh** to update the list after generating new splats.

### Controls

| Action | Control |
|---|---|
| Orbit | Left-click + drag |
| Zoom | Scroll wheel |
| Pan | Right-click + drag |


---

### Roadmap

- Export frame from splat
  - Send to edit
  - Download
  - Crop
- Export `PLY` as `SPLAT` or `KSPLAT`
- Export `SPLAT` as `KSPLAT`
