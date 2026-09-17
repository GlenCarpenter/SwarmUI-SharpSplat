using GlenCarpenter.Extensions.SharpSplat;
using Newtonsoft.Json.Linq;

static void Check(bool condition, string message)
{
    if (!condition)
    {
        throw new InvalidOperationException(message);
    }
}

JObject graphs = new();
foreach (string model in new[] { "moge1", "moge2", "moge3" })
{
    var checkpoint = Native3DWorkflow.MoGeCheckpoint(model);
    Check(checkpoint.Hash.Length == 64 && checkpoint.Hash.All(Uri.IsHexDigit), $"{model} checksum");
    foreach (string format in new[] { "glb", "glb_untextured", "ply", "splat" })
    {
        bool gaussian = format is "ply" or "splat";
        JObject graph = Native3DWorkflow.Build("AQ==", model, 123, "sharpsplat3d/test", 5, 0, format);
        Check(graph.Count == 6, $"{model}/{format} graph size");
        Check((string)graph["1"]["inputs"]["image_base64"] == "AQ==", "Image forwarding");
        Check((string)graph["2"]["inputs"]["model_name"] == checkpoint.Filename, "Checkpoint selection");
        Check((int)graph["3"]["inputs"]["resolution_level"] == 5, "Resolution forwarding");
        Check((int)graph["3"]["inputs"]["refine_steps"] == 0, "Zero refinement forwarding");
        Check((string)graph["4"]["class_type"] == (gaussian ? "SharpSplatMoGeToSplat" : "MoGePointMapToMesh"), "Geometry branch");
        Check((string)graph["5"]["class_type"] == (gaussian ? "SplatToFile3D" : "MeshToFile3D"), "Serializer branch");
        Check((string)graph["6"]["class_type"] == (gaussian ? "SaveGaussianSplat" : "Save3DAdvanced"), "Saver branch");
        Check((string)graph["6"]["inputs"]["filename_prefix"] == "sharpsplat3d/test", "Output prefix");
        if (gaussian)
        {
            Check((string)graph["5"]["inputs"]["format"] == "ply", "Native Gaussian intermediate format");
        }
        else
        {
            Check((bool)graph["4"]["inputs"]["texture"] == (format == "glb"), "Texture selection");
        }
        foreach (JProperty node in graph.Properties())
        {
            foreach (JArray link in node.Value["inputs"].Values().OfType<JArray>())
            {
                Check(link.Count == 2 && graph.ContainsKey((string)link[0]) && (int)link[1] == 0, "Graph connections");
            }
        }
        graphs[$"{model}_{format}"] = graph;
    }
}
JObject defaults = Native3DWorkflow.Build("AQ==", "moge3", 0, "test");
Check((int)defaults["3"]["inputs"]["resolution_level"] == 9, "Default resolution");
Check((int)defaults["3"]["inputs"]["refine_steps"] == 3, "Default refinement");
foreach (string model in new[] { "pixal3d", "trellis2" })
{
    JObject graph = Native3DWorkflow.Build("AQ==", model, 123, "test");
    Check((string)graph["37"]["class_type"] == "Save3DAdvanced", "Existing mesh saver");
    Check((int)graph["12"]["inputs"]["seed"] == 123, "Existing seed behavior");
    Check(graph.ContainsKey("38") == (model == "pixal3d"), "Existing camera conditioning");
}
foreach (Task<JObject> request in new[]
{
    SharpSplatAPI.Native3DGenerateViaComfy(null, "", model: "moge1"),
    SharpSplatAPI.Native3DGenerateViaComfy(null, "not-base64", model: "moge1"),
    SharpSplatAPI.Native3DGenerateViaComfy(null, "AQ==", model: "invalid"),
    SharpSplatAPI.Native3DGenerateViaComfy(null, "AQ==", model: "moge3", resolutionLevel: 10),
    SharpSplatAPI.Native3DGenerateViaComfy(null, "AQ==", model: "moge3", refineSteps: -1),
    SharpSplatAPI.Native3DGenerateViaComfy(null, "AQ==", model: "moge3", refineSteps: 9),
    SharpSplatAPI.Native3DGenerateViaComfy(null, "AQ==", model: "moge2", outputFormat: "obj"),
    SharpSplatAPI.Native3DGenerateViaComfy(null, "AQ==", model: "trellis2", outputFormat: "splat")
})
{
    Check((bool)(await request)["success"] == false, "Invalid request must fail before model provisioning");
}
if (args.Length == 1)
{
    File.WriteAllText(args[0], graphs.ToString());
}
Console.WriteLine("PASS: 12 MoGe workflows, defaults, graph links, existing model branches, and API validation.");