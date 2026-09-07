using Newtonsoft.Json.Linq;

namespace GlenCarpenter.Extensions.SharpSplat;

/// <summary>Loads and parameterizes the API-format version of Comfy-Org's native Pixal3D and TRELLIS.2 workflow.</summary>
public static class Native3DWorkflow
{
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
    public static JObject Build(string imageBase64, string model, long seed, string filenamePrefix)
    {
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
