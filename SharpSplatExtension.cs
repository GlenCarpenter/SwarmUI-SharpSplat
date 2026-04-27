using System.IO;
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
    }

    /// <inheritdoc/>
    public override void OnInit()
    {
        Logs.Info("SharpSplat extension initialized.");
        SharpSplatAPI.Register();
    }
}
