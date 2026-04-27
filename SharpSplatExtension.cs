using System.IO;
using Newtonsoft.Json.Linq;
using SwarmUI.Accounts;
using SwarmUI.Builtin_ComfyUIBackend;
using SwarmUI.Core;
using SwarmUI.Text2Image;
using SwarmUI.Utils;
using SwarmUI.WebAPI;

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

        // Register the <sharpsplat> prompt token. When present it sets a flag on the input
        // so the workflow step appends a SharpSplatGenerate node to the same ComfyUI job.
        T2IPromptHandling.PromptTagBasicProcessors["sharpsplat"] = (data, context) =>
        {
            context.Input.ExtraMeta["sharpsplat_requested"] = true;
            return "";
        };
        T2IPromptHandling.PromptTagLengthEstimators["sharpsplat"] = (data, context) => "";
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
        // Inject a SharpSplatGenerate node into any workflow where <sharpsplat> was used.
        // Running inside the same ComfyUI job guarantees gen->splat ordering with no extra
        // coordination — the queue serialises everything naturally.
        WorkflowGenerator.AddStep(g =>
        {
            if (!g.UserInput.ExtraMeta.ContainsKey("sharpsplat_requested"))
            {
                return;
            }
            Session session = g.UserInput.SourceSession;
            if (session is null)
            {
                Logs.Warning("SharpSplat: No session available for <sharpsplat> workflow step.");
                return;
            }
            string splatsOutputDir = Path.Combine(WebServer.GetUserOutputRoot(session.User), "splats");
            Directory.CreateDirectory(splatsOutputDir);
            string splatFilename = $"sharpsplat_{Guid.NewGuid():N}.splat";
            string splatPath = Path.Combine(splatsOutputDir, splatFilename);
            // CurrentMedia is already a decoded image at this priority (SaveImage runs at 10).
            WGNodeData image = g.CurrentMedia.AsRawImage(g.CurrentVae);
            g.CreateNode("SharpSplatGenerate", new JObject
            {
                ["images"] = image.Path,
                ["output_path"] = splatPath
            });
            Logs.Info($"SharpSplat: Added SharpSplatGenerate node targeting '{splatFilename}'.");
        }, 11);
    }
}
