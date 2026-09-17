using System.IO;
using Newtonsoft.Json.Linq;

namespace GlenCarpenter.Extensions.SharpSplat;

/// <summary>Builds native ComfyUI workflows for Pixal3D, TRELLIS.2, and MoGe mesh or Gaussian output.</summary>
public static class Native3DWorkflow
{
    public static bool IsMoGe(string model) => model is "moge1" or "moge2" or "moge3";

    public static (string Filename, string Hash) MoGeCheckpoint(string model) => model switch
    {
        "moge1" => ("moge_1_vitl_fp16.safetensors", "34cab296d0474b02ab477fcef0cc3deee859f3edd4fd6f947d8ff096760a3d56"),
        "moge2" => ("moge_2_vitl_normal_fp16.safetensors", "cb1a692d03235671e959e81360d7b4d9f44aefadb1f852d6ca6aa17799d5e31f"),
        "moge3" => ("moge_3_vitl_fp16.safetensors", "52ad9a13037a28fd65003cae7df056c8f903f5aed2c3a5c802be0f5c74a6a7b8"),
        _ => throw new ArgumentException("Unknown MoGe model.", nameof(model))
    };

    private static JObject BuildMoGe(string imageBase64, string model, string filenamePrefix, int resolutionLevel, int refineSteps, string outputFormat)
    {
        JObject inference = new()
        {
            ["moge_model"] = Link("2"),
            ["image"] = Link("1"),
            ["resolution_level"] = resolutionLevel,
            ["fov_x_degrees"] = 0.0,
            ["batch_size"] = 1,
            ["force_projection"] = true,
            ["apply_mask"] = true,
            ["refine_steps"] = refineSteps
        };
        bool gaussian = outputFormat is "ply" or "splat";
        return new JObject
        {
            ["1"] = Node("SwarmLoadImageB64", new JObject { ["image_base64"] = imageBase64 }),
            ["2"] = Node("LoadMoGeModel", new JObject { ["model_name"] = MoGeCheckpoint(model).Filename }),
            ["3"] = Node("MoGeInference", inference),
            ["4"] = gaussian ? Node("SharpSplatMoGeToSplat", new JObject { ["moge_geometry"] = Link("3") }) : Node("MoGePointMapToMesh", new JObject
            {
                ["moge_geometry"] = Link("3"),
                ["batch_index"] = 0,
                ["decimation"] = 1,
                ["discontinuity_threshold"] = 0.04,
                ["texture"] = outputFormat != "glb_untextured"
            }),
            ["5"] = gaussian
                ? Node("SplatToFile3D", new JObject { ["splat"] = Link("4"), ["format"] = "ply" })
                : Node("MeshToFile3D", new JObject { ["mesh"] = Link("4") }),
            ["6"] = Node(gaussian ? "SaveGaussianSplat" : "Save3DAdvanced", new JObject
            {
                ["model_3d"] = Link("5"),
                ["filename_prefix"] = filenamePrefix,
                ["viewport_state"] = new JObject(),
                ["width"] = 1024,
                ["height"] = 1024
            })
        };
    }

    /// <summary>Loads a fresh workflow copy from the extension assembly.</summary>
    private static JObject LoadTemplate()
    {
        using Stream stream = typeof(Native3DWorkflow).Assembly.GetManifestResourceStream("SharpSplat.Workflows.Native3DImageToModel")
            ?? throw new InvalidOperationException("The embedded native 3D workflow template is missing.");
        using StreamReader reader = new(stream);
        return JObject.Parse(reader.ReadToEnd());
    }

    /// <summary>Returns the mutable inputs object for a workflow node.</summary>
    private static JObject Inputs(JObject workflow, string nodeId)
    {
        return (JObject)workflow[nodeId]["inputs"];
    }

    /// <summary>Builds a connection to a ComfyUI node output.</summary>
    private static JArray Link(string nodeId, int output = 0)
    {
        return new JArray { nodeId, output };
    }

    /// <summary>Builds one ComfyUI API-format node.</summary>
    private static JObject Node(string classType, JObject inputs)
    {
        return new JObject
        {
            ["class_type"] = classType,
            ["inputs"] = inputs
        };
    }

    /// <summary>Loads the official workflow snapshot and applies request-specific values.</summary>
    public static JObject Build(string imageBase64, string model, long seed, string filenamePrefix, int resolutionLevel = 9, int refineSteps = 3, string outputFormat = "glb")
    {
        if (IsMoGe(model))
        {
            return BuildMoGe(imageBase64, model, filenamePrefix, resolutionLevel, refineSteps, outputFormat);
        }
        bool isTrellis = model == "trellis2";
        long textureSeed = seed == long.MaxValue ? seed : seed + 1;
        JObject workflow = LoadTemplate();
        Inputs(workflow, "1")["image_base64"] = imageBase64;
        Inputs(workflow, "6")["unet_name"] = isTrellis ? "trellis_2_int8_convrot.safetensors" : "pixal3d_int8_convrot.safetensors";
        Inputs(workflow, "12")["seed"] = seed;
        Inputs(workflow, "18")["seed"] = seed;
        Inputs(workflow, "20")["seed"] = seed;
        Inputs(workflow, "22")["seed"] = textureSeed;
        Inputs(workflow, "37")["filename_prefix"] = filenamePrefix;

        if (isTrellis)
        {
            Inputs(workflow, "4")["pad_factor"] = 1.0;
            workflow["7"] = Node("Trellis2Conditioning", new JObject
            {
                ["clip_vision_model"] = Link("5"),
                ["image"] = Link("4")
            });
            workflow.Remove("38");
            workflow.Remove("39");
            workflow.Remove("40");
        }
        return workflow;
    }
}
