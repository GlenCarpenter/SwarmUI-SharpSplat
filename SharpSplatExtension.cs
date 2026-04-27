using System.IO;
using SwarmUI.Builtin_ComfyUIBackend;
using SwarmUI.Core;
using SwarmUI.Utils;

// NOTE: Namespace must NOT contain "SwarmUI" (reserved for built-ins).
namespace SharpSplat;

/// <summary>Extension that integrates Apple ml-sharp into SwarmUI.
/// Adds a "Generate 3D Splat" button to the generate tab image viewer.
/// Takes the current generated image and runs <c>sharp predict</c> to produce a
/// 3D Gaussian Splat (PLY file) that can be downloaded and used in any 3DGS renderer.
/// Based on: https://github.com/apple/ml-sharp</summary>
public class SharpSplatExtension : Extension
{
    /// <summary>File path to this extension's folder, shared with the static API class.</summary>
    public static string ExtFolder;

    /// <inheritdoc/>
    public override void OnPreInit()
    {
        ExtFolder = FilePath;
        ScriptFiles.Add("Assets/sharp_splat.js");
        StyleSheetFiles.Add("Assets/sharp_splat.css");
        // The built viewer bundle is served on demand via the extension file route.
        // Build it by running `npm install` in the extension folder.
        OtherAssets.Add("Assets/splat-viewer.bundle.js");
        // Register the ComfyNodes folder so ComfyUI picks up the SharpSplatGenerate node.
        ComfyUISelfStartBackend.CustomNodePaths.Add(Path.GetFullPath($"{FilePath}/ComfyNodes"));
    }

    /// <inheritdoc/>
    public override void OnInit()
    {
        Logs.Info("SharpSplat extension initialized.");
        SharpSplatAPI.Register();
        string bundlePath = Path.Combine(ExtFolder, "Assets", "splat-viewer.bundle.js");
        if (!File.Exists(bundlePath))
        {
            Logs.Warning("SharpSplat: splat-viewer.bundle.js not found. Run 'npm install' in the extension folder to build the viewer bundle.");
        }
    }
}
