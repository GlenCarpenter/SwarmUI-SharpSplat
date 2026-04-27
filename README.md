# SwarmUI-SharpSplat

A [SwarmUI](https://github.com/mcmonkeyprojects/SwarmUI) extension that turns any generated image into a 3D Gaussian Splat directly inside the browser.

It uses Apple's [ml-sharp](https://github.com/apple/ml-sharp) to reconstruct a 3D scene from a single image, converts the output to the compact `.splat` format, and renders it interactively in a dedicated **Splat Viewer** tab powered by [gsplat.js](https://github.com/huggingface/gsplat.js).

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
      └─► ply2splat  →  .splat  (compact 32-bytes-per-splat binary)
                               saved to Output/{user}/splats/
      │
      ▼  (returns /View/... HTTP URL)
Splat Viewer tab (browser)
      │
      └─► gsplat.js  →  interactive WebGL viewer
```

### Step by step

1. **Generate an image** in the SwarmUI Generate tab as normal.
2. Click the **Generate 3D Splat** button that appears on the image.
3. The image is sent to the SwarmUI server. The extension:
   - Writes the image to a temp directory.
   - Runs `sharp predict` via ml-sharp to reconstruct a 3D Gaussian Splat as a `.ply` file.
   - Converts the `.ply` to `.splat` using `ply2splat` (avoids browser-side PLY parser limitations).
   - Saves the `.splat` file permanently to `Output/{user}/splats/`.
   - Returns the HTTP URL of the saved file.
4. SwarmUI automatically navigates to the **Splat Viewer** tab and loads the result.
5. Orbit, zoom, and pan around the scene with the mouse.

Previously generated splats are listed in the sidebar and can be reloaded at any time.

---

## Requirements

- SwarmUI with a working ComfyUI backend (provides the Python environment).
- An NVIDIA GPU is strongly recommended. `ml-sharp` uses PyTorch for inference.
- Internet access on first use to install Python dependencies and load gsplat.js from CDN.

Python dependencies are installed automatically the first time you click **Generate 3D Splat**:

| Package | Purpose |
|---|---|
| [ml-sharp](https://github.com/apple/ml-sharp) | Monocular 3D Gaussian Splat reconstruction |
| [ply2splat](https://github.com/bastikohn/ply2splat) | PLY → `.splat` binary conversion |

---

## Installation

1. In SwarmUI, go to **Server → Extensions**.
2. Click **Install Extension** and provide this repository's URL.
3. Restart SwarmUI.

Or clone manually into `src/Extensions/`:

```sh
cd src/Extensions
git clone https://github.com/your-org/SwarmUI-SharpSplat
```

---

## Usage

### Generating a splat

1. Generate any image in the **Generate** tab.
2. Click **Generate 3D Splat** in the image button bar.
3. Wait for inference (30–120 seconds depending on GPU).
4. The **Splat Viewer** tab opens automatically with the result loaded.

### Viewing previous splats

1. Click the **Splat Viewer** top-level tab.
2. Previously generated `.splat` files are listed in the left sidebar, newest first.
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
- Support `.ply`
  - Export to `.splat` (currently converting in pipeline)
