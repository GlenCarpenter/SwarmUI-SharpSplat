using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;
using SwarmUI.Accounts;
using SwarmUI.Builtin_ComfyUIBackend;
using SwarmUI.Core;
using SwarmUI.Utils;
using SwarmUI.WebAPI;

namespace GlenCarpenter.Extensions.SharpSplat;

/// <summary>Permission definitions for the SharpSplat extension.</summary>
public static class SharpSplatPermissions
{
    /// <summary>Permission group for SharpSplat.</summary>
    public static readonly PermInfoGroup SharpSplatPermGroup = new("SharpSplat", "Permissions related to Sharp 3D Gaussian Splat generation.");

    /// <summary>Permission to call the splat-generation API.</summary>
    public static readonly PermInfo PermGenerateSplat = Permissions.Register(new(
        "sharpsplat_generate_splat",
        "Generate 3D Splat",
        "Allows the user to run ml-sharp Gaussian Splat generation on images.",
        PermissionDefault.USER,
        SharpSplatPermGroup));
}

/// <summary>API routes for the SharpSplat extension.</summary>
[API.APIClass("API routes related to the SharpSplat (ml-sharp) extension")]
public static class SharpSplatAPI
{
    /// <summary>Registers all API calls for this extension.</summary>
    public static void Register()
    {
        API.RegisterAPICall(SharpGenerateSplat, true, SharpSplatPermissions.PermGenerateSplat);
        API.RegisterAPICall(SharpGenerateSplatViaComfy, true, SharpSplatPermissions.PermGenerateSplat);
        API.RegisterAPICall(VGGTGenerateSplatViaComfy, true, SharpSplatPermissions.PermGenerateSplat);
        API.RegisterAPICall(VGGTGenerateSplat, true, SharpSplatPermissions.PermGenerateSplat);
        API.RegisterAPICall(InstantSplatGenerateSplatViaComfy, true, SharpSplatPermissions.PermGenerateSplat);
        API.RegisterAPICall(InstantSplatGenerateSplat, true, SharpSplatPermissions.PermGenerateSplat);
        API.RegisterAPICall(SharpListSplats, false, SharpSplatPermissions.PermGenerateSplat);
        API.RegisterAPICall(SharpDeleteSplat, true, SharpSplatPermissions.PermGenerateSplat);
        API.RegisterAPICall(SharpSaveCanvasExport, true, SharpSplatPermissions.PermGenerateSplat);
    }

    /// <summary>Guards one-time dependency installation per process lifetime.</summary>
    private static volatile bool _dependenciesEnsured = false;
    private static readonly SemaphoreSlim _depLock = new(1, 1);

    /// <summary>
    /// Runs <c>pip install</c> once per process lifetime to ensure ml-sharp is available
    /// in the Python environment used for inference.
    /// </summary>
    private static async Task EnsureDependenciesAsync()
    {
        if (_dependenciesEnsured)
        {
            return;
        }
        await _depLock.WaitAsync();
        try
        {
            if (_dependenciesEnsured)
            {
                return;
            }
            string requirementsPath = Path.GetFullPath($"{SharpSplatExtension.ExtFolder}/requirements.txt");
            if (!File.Exists(requirementsPath))
            {
                Logs.Warning("SharpSplat: requirements.txt not found, skipping dependency check.");
                _dependenciesEnsured = true;
                return;
            }
            Logs.Info("SharpSplat: Checking/installing ml-sharp Python dependencies...");
            ProcessStartInfo psi = BuildPythonPsi();
            psi.ArgumentList.Add("-m");
            psi.ArgumentList.Add("pip");
            psi.ArgumentList.Add("install");
            psi.ArgumentList.Add("--quiet");
            psi.ArgumentList.Add("-r");
            psi.ArgumentList.Add(requirementsPath);
            using Process process = Process.Start(psi);
            // Drain stdout and stderr concurrently before waiting, to prevent buffer deadlock.
            Task<string> pipOut = process.StandardOutput.ReadToEndAsync();
            Task<string> pipErr = process.StandardError.ReadToEndAsync();
            await process.WaitForExitAsync();
            string pipOutStr = (await pipOut).Trim();
            string pipErrStr = (await pipErr).Trim();
            if (process.ExitCode != 0)
            {
                Logs.Warning($"SharpSplat: pip install exited with code {process.ExitCode}. {pipErrStr}");
            }
            else
            {
                Logs.Info("SharpSplat: Python dependencies ready.");
            }
            _dependenciesEnsured = true;
        }
        finally
        {
            _depLock.Release();
        }
    }

    /// <summary>
    /// Builds a <see cref="ProcessStartInfo"/> pointed at the same Python executable used
    /// by the rest of SwarmUI's Python helpers (ComfyUI embedded or venv, then system fallback).
    /// </summary>
    private static ProcessStartInfo BuildPythonPsi()
    {
        ProcessStartInfo psi = new()
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = Environment.CurrentDirectory
        };
        if (File.Exists("./dlbackend/comfy/python_embeded/python.exe"))
        {
            psi.FileName = Path.GetFullPath("./dlbackend/comfy/python_embeded/python.exe");
            psi.WorkingDirectory = Path.GetFullPath("./dlbackend/comfy/");
            psi.Environment["PATH"] = PythonLaunchHelper.ReworkPythonPaths(
                Path.GetFullPath("./dlbackend/comfy/python_embeded"));
        }
        else if (File.Exists("./dlbackend/ComfyUI/venv/bin/python"))
        {
            psi.FileName = Path.GetFullPath("./dlbackend/ComfyUI/venv/bin/python");
            psi.Environment["PATH"] = PythonLaunchHelper.ReworkPythonPaths(
                Path.GetFullPath("./dlbackend/ComfyUI/venv/bin"));
        }
        else
        {
            psi.FileName = RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? "python" : "python3";
        }
        PythonLaunchHelper.CleanEnvironmentOfPythonMess(psi, "SharpSplat: ");
        return psi;
    }

    /// <summary>
    /// Sanitizes and resolves a unique output filename/path for generated splat files.
    /// Uses a UUID suffix whenever the caller did not provide a meaningful prefix.
    /// </summary>
    private static (string OutputFormat, string SafePrefix, string OutputFilename, string OutputPath) PrepareUniqueOutputPath(Session session, string filenamePrefix, string outputFormat)
    {
        string safePrefix = string.Concat(
            (filenamePrefix ?? "output")
                .Where(c => char.IsLetterOrDigit(c) || c == '-' || c == '_' || c == '.'));
        if (string.IsNullOrWhiteSpace(safePrefix))
        {
            safePrefix = "output";
        }
        if (outputFormat != "splat")
        {
            outputFormat = "ply";
        }
        string fileExtension = $".{outputFormat}";
        string splatsOutputDir = Path.Combine(WebServer.GetUserOutputRoot(session.User), "splats");
        Directory.CreateDirectory(splatsOutputDir);

        // Unknown/default names should always get a UUID to avoid queued-job collisions.
        bool useUuidSuffix = safePrefix == "output";
        string outputFilename;
        if (useUuidSuffix)
        {
            outputFilename = $"{safePrefix}_{Guid.NewGuid():N}{fileExtension}";
        }
        else
        {
            outputFilename = $"{safePrefix}{fileExtension}";
        }

        string outputPath = Path.Combine(splatsOutputDir, outputFilename);
        int dedupeCounter = 0;
        while (File.Exists(outputPath))
        {
            dedupeCounter++;
            if (useUuidSuffix)
            {
                outputFilename = $"{safePrefix}_{Guid.NewGuid():N}{fileExtension}";
            }
            else
            {
                string timestamp = DateTime.UtcNow.ToString("yyyyMMdd_HHmmss");
                outputFilename = $"{safePrefix}_{timestamp}_{dedupeCounter}{fileExtension}";
            }
            outputPath = Path.Combine(splatsOutputDir, outputFilename);
        }

        return (outputFormat, safePrefix, outputFilename, outputPath);
    }

    /// <summary>
    /// Generates a 3D Gaussian Splat PLY file from the provided base64-encoded image using ml-sharp.
    /// </summary>
    /// <param name="session">The calling user session.</param>
    /// <param name="imageBase64">Base64-encoded image data (PNG/JPG/WEBP).</param>
    /// <param name="filenamePrefix">Optional filename prefix to use for the output .splat file.</param>
    public static async Task<JObject> SharpGenerateSplat(Session session, string imageBase64, string filenamePrefix = "output", string outputFormat = "ply")
    {
        if (string.IsNullOrWhiteSpace(imageBase64))
        {
            return new JObject { ["success"] = false, ["error"] = "No image data provided." };
        }

        byte[] imageBytes;
        try
        {
            imageBytes = Convert.FromBase64String(imageBase64);
        }
        catch (FormatException)
        {
            return new JObject { ["success"] = false, ["error"] = "Invalid base64 image data." };
        }

        (string outputFormatSanitized, string safePrefix, string outputFilename, string outputPath) =
            PrepareUniqueOutputPath(session, filenamePrefix, outputFormat);
        outputFormat = outputFormatSanitized;

        await EnsureDependenciesAsync();

        string tempRoot = Path.Combine(Path.GetTempPath(), $"sharpsplat_{Guid.NewGuid():N}");
        string inputDir = Path.Combine(tempRoot, "input");
        string outputDir = Path.Combine(tempRoot, "output");
        string tempImagePath = Path.Combine(inputDir, "image.png");
        string wrapperScript = Path.GetFullPath($"{SharpSplatExtension.ExtFolder}/run_sharp.py");

        try
        {
            Directory.CreateDirectory(inputDir);
            Directory.CreateDirectory(outputDir);
            await File.WriteAllBytesAsync(tempImagePath, imageBytes);

            ProcessStartInfo psi = BuildPythonPsi();
            psi.ArgumentList.Add("-s");
            psi.ArgumentList.Add(wrapperScript);
            psi.ArgumentList.Add("predict");
            psi.ArgumentList.Add("-i");
            psi.ArgumentList.Add(inputDir);
            psi.ArgumentList.Add("-o");
            psi.ArgumentList.Add(outputDir);

            Logs.Info($"SharpSplat: Running ml-sharp predict on image ({imageBytes.Length} bytes)...");
            using Process process = Process.Start(psi);
            Task<string> stdoutTask = process.StandardOutput.ReadToEndAsync();
            Task<string> stderrTask = process.StandardError.ReadToEndAsync();
            await process.WaitForExitAsync(CancellationToken.None);
            string stdout = (await stdoutTask).Trim();
            string stderr = (await stderrTask).Trim();

            if (!string.IsNullOrWhiteSpace(stdout))
            {
                Logs.Debug($"SharpSplat stdout: {stdout}");
            }
            if (!string.IsNullOrWhiteSpace(stderr))
            {
                Logs.Warning($"SharpSplat stderr: {stderr}");
            }

            if (process.ExitCode != 0)
            {
                string errMsg = string.IsNullOrWhiteSpace(stderr) ? $"sharp exited with code {process.ExitCode}" : stderr.Split('\n').Last(l => !string.IsNullOrWhiteSpace(l));
                Logs.Error($"SharpSplat: sharp predict failed (exit {process.ExitCode}): {stderr}");
                return new JObject { ["success"] = false, ["error"] = $"sharp predict failed: {errMsg}" };
            }

            string[] plyFiles = Directory.GetFiles(outputDir, "*.ply", SearchOption.AllDirectories);
            if (plyFiles.Length == 0)
            {
                Logs.Warning($"SharpSplat: No .ply files found in output directory after sharp predict.");
                return new JObject { ["success"] = false, ["error"] = "No PLY output was produced. Check server logs for details." };
            }

            // Pick the first PLY file (one image input produces one PLY).
            string plyPath = plyFiles[0];

            if (outputFormat == "splat")
            {
                string convertScript = Path.GetFullPath($"{SharpSplatExtension.ExtFolder}/run_convert.py");
                ProcessStartInfo convertPsi = BuildPythonPsi();
                convertPsi.ArgumentList.Add("-s");
                convertPsi.ArgumentList.Add(convertScript);
                convertPsi.ArgumentList.Add(plyPath);
                convertPsi.ArgumentList.Add(outputPath);
                Logs.Info("SharpSplat: Converting PLY to .splat format via ply2splat...");
                using Process convertProcess = Process.Start(convertPsi);
                Task<string> convertOut = convertProcess.StandardOutput.ReadToEndAsync();
                Task<string> convertErr = convertProcess.StandardError.ReadToEndAsync();
                await convertProcess.WaitForExitAsync(CancellationToken.None);
                string convertOutStr = (await convertOut).Trim();
                string convertErrStr = (await convertErr).Trim();
                if (!string.IsNullOrWhiteSpace(convertOutStr))
                {
                    Logs.Debug($"SharpSplat convert stdout: {convertOutStr}");
                }
                if (convertProcess.ExitCode != 0)
                {
                    Logs.Error($"SharpSplat: ply2splat conversion failed (exit {convertProcess.ExitCode}): {convertErrStr}");
                    return new JObject { ["success"] = false, ["error"] = $"PLY to .splat conversion failed: {convertErrStr}" };
                }
                if (!File.Exists(outputPath))
                {
                    Logs.Error("SharpSplat: ply2splat reported success but output file does not exist.");
                    return new JObject { ["success"] = false, ["error"] = "PLY to .splat conversion produced no output file." };
                }
            }
            else
            {
                File.Copy(plyPath, outputPath, overwrite: false);
                if (!File.Exists(outputPath))
                {
                    Logs.Error("SharpSplat: PLY copy failed — output file does not exist.");
                    return new JObject { ["success"] = false, ["error"] = "Failed to save PLY output file." };
                }
            }

            // Use /View/{userId}/... which always resolves relative to GetUserOutputRoot(userId),
            // regardless of the AppendUserNameToOutputPath server setting.
            string outputUrl = $"/View/{Uri.EscapeDataString(session.User.UserID)}/splats/{Uri.EscapeDataString(outputFilename)}";
            long outputBytes = new FileInfo(outputPath).Length;
            Logs.Info($"SharpSplat: Successfully produced '{outputFilename}' ({outputBytes} bytes) at {outputUrl}.");
            return new JObject
            {
                ["success"] = true,
                ["splatUrl"] = outputUrl,
                ["filename"] = outputFilename
            };
        }
        catch (Exception ex)
        {
            Logs.Error($"SharpSplat error: {ex.Message}");
            return new JObject { ["success"] = false, ["error"] = ex.Message };
        }
        finally
        {
            // Note: splatPath is inside splatsOutputDir (user Output), intentionally kept.
            // tempRoot contains only the PLY and input image — safe to delete.
            try
            {
                if (Directory.Exists(tempRoot))
                {
                    Directory.Delete(tempRoot, recursive: true);
                }
            }
            catch
            {
                // Best-effort cleanup; temp files are cleared on next OS restart anyway.
            }
        }
    }

    /// <summary>
    /// Generates a 3D Gaussian Splat PLY file from the provided base64-encoded image by
    /// submitting a ComfyUI workflow containing the <c>SharpSplatGenerate</c> custom node.
    /// This routes generation through the Comfy backend queue rather than running a
    /// standalone Python subprocess directly.
    /// </summary>
    /// <param name="session">The calling user session.</param>
    /// <param name="imageBase64">Base64-encoded image data (PNG/JPG/WEBP).</param>
    /// <param name="filenamePrefix">Optional filename prefix for the output .splat file.</param>
    public static async Task<JObject> SharpGenerateSplatViaComfy(Session session, string imageBase64, string filenamePrefix = "output", string outputFormat = "ply")
    {
        if (string.IsNullOrWhiteSpace(imageBase64))
        {
            return new JObject { ["success"] = false, ["error"] = "No image data provided." };
        }
        try
        {
            Convert.FromBase64String(imageBase64);
        }
        catch (FormatException)
        {
            return new JObject { ["success"] = false, ["error"] = "Invalid base64 image data." };
        }
        (string outputFormatSanitized, string safePrefix, string outputFilename, string outputPath) =
            PrepareUniqueOutputPath(session, filenamePrefix, outputFormat);
        outputFormat = outputFormatSanitized;
        JObject workflow = new()
        {
            ["1"] = new JObject()
            {
                ["class_type"] = "SwarmLoadImageB64",
                ["inputs"] = new JObject()
                {
                    ["image_base64"] = imageBase64
                }
            },
            ["2"] = new JObject()
            {
                ["class_type"] = "SharpSplatGenerate",
                ["inputs"] = new JObject()
                {
                    ["images"] = new JArray() { "1", 0 },
                    ["output_path"] = outputPath,
                    ["output_format"] = outputFormat
                }
            }
        };
        try
        {
            Logs.Info($"SharpSplat: Submitting Gaussian Splat generation via ComfyUI backend for '{safePrefix}'...");
            using Session.GenClaim claim = session.Claim(liveGens: 1);
            await ComfyUIBackendExtension.RunArbitraryWorkflowOnFirstBackend(workflow.ToString(), _ => { });
        }
        catch (Exception ex)
        {
            Logs.Error($"SharpSplat: ComfyUI workflow error: {ex.Message}");
            return new JObject { ["success"] = false, ["error"] = $"ComfyUI workflow failed: {ex.Message}" };
        }
        if (!File.Exists(outputPath))
        {
            Logs.Error($"SharpSplat: ComfyUI workflow completed but output file not found at '{outputPath}'.");
            return new JObject { ["success"] = false, ["error"] = "Workflow completed but output file was not produced. Check server logs." };
        }
        string outputUrl = $"/View/{Uri.EscapeDataString(session.User.UserID)}/splats/{Uri.EscapeDataString(outputFilename)}";
        long outputBytes = new FileInfo(outputPath).Length;
        Logs.Info($"SharpSplat: Successfully produced '{outputFilename}' ({outputBytes} bytes) at {outputUrl}.");
        return new JObject
        {
            ["success"] = true,
            ["splatUrl"] = outputUrl,
            ["filename"] = outputFilename
        };
    }

    /// <summary>
    /// Generates a Gaussian splat PLY via the <c>VGGTSplatGenerate</c> ComfyUI custom node.
    /// Submits a single-node workflow through the Comfy backend queue so VGGT shares
    /// the backend's VRAM slot and does not run while other generations are in progress.
    /// </summary>
    /// <param name="session">The calling user session.</param>
    /// <param name="imagesBase64">Array of base64-encoded image data (PNG/JPG/WEBP).</param>
    /// <param name="filenamePrefix">Optional filename prefix for the output file.</param>
    /// <param name="outputFormat">Output format: "ply" or "splat".</param>
    public static async Task<JObject> VGGTGenerateSplatViaComfy(Session session, string[] imagesBase64, string filenamePrefix = "output", string outputFormat = "ply", bool padToSquare = false)
    {
        if (imagesBase64 is null || imagesBase64.Length == 0)
        {
            return new JObject { ["success"] = false, ["error"] = "No images provided." };
        }
        foreach (string b64 in imagesBase64)
        {
            if (string.IsNullOrWhiteSpace(b64))
            {
                return new JObject { ["success"] = false, ["error"] = "One or more images in the array is empty." };
            }
            try { Convert.FromBase64String(b64); }
            catch (FormatException)
            {
                return new JObject { ["success"] = false, ["error"] = "Invalid base64 data in images array." };
            }
        }
        (string outputFormatSanitized, string safePrefix, string outputFilename, string outputPath) =
            PrepareUniqueOutputPath(session, filenamePrefix, outputFormat);
        outputFormat = outputFormatSanitized;
        // Serialise the base64 array to a JSON string for the workflow input.
        string imagesJson = new JArray(imagesBase64.Cast<object>().ToArray()).ToString(Newtonsoft.Json.Formatting.None);
        JObject workflow = new()
        {
            ["1"] = new JObject
            {
                ["class_type"] = "VGGTSplatGenerate",
                ["inputs"] = new JObject
                {
                    ["images_base64_json"] = imagesJson,
                    ["output_path"] = outputPath,
                    ["output_format"] = outputFormat,
                    ["pad_to_square"] = padToSquare
                }
            }
        };
        try
        {
            Logs.Info($"SharpSplat: Submitting VGGT generation via ComfyUI backend for '{safePrefix}' ({imagesBase64.Length} image(s))...");
            using Session.GenClaim claim = session.Claim(liveGens: 1);
            await ComfyUIBackendExtension.RunArbitraryWorkflowOnFirstBackend(workflow.ToString(), _ => { });
        }
        catch (Exception ex)
        {
            Logs.Error($"SharpSplat: VGGT ComfyUI workflow error: {ex.Message}");
            return new JObject { ["success"] = false, ["error"] = $"ComfyUI workflow failed: {ex.Message}" };
        }
        if (!File.Exists(outputPath))
        {
            Logs.Error($"SharpSplat: VGGT ComfyUI workflow completed but output file not found at '{outputPath}'.");
            return new JObject { ["success"] = false, ["error"] = "Workflow completed but output file was not produced. Check server logs." };
        }
        string outputUrl = $"/View/{Uri.EscapeDataString(session.User.UserID)}/splats/{Uri.EscapeDataString(outputFilename)}";
        long outputBytes = new FileInfo(outputPath).Length;
        Logs.Info($"SharpSplat: VGGT (Comfy) produced '{outputFilename}' ({outputBytes} bytes) at {outputUrl}.");
        return new JObject
        {
            ["success"] = true,
            ["splatUrl"] = outputUrl,
            ["filename"] = outputFilename
        };
    }

    /// <summary>
    /// Generates a Gaussian splat PLY file from one or more base64-encoded images using VGGT
    /// via a direct Python subprocess. Used as a fallback when no ComfyUI backend is available.
    /// </summary>
    /// <param name="session">The calling user session.</param>
    /// <param name="imagesBase64">Array of base64-encoded image data (PNG/JPG/WEBP).</param>
    /// <param name="filenamePrefix">Optional filename prefix for the output file.</param>
    /// <param name="outputFormat">Output format: "ply" or "splat". VGGT always produces PLY; splat conversion is applied if requested.</param>
    public static async Task<JObject> VGGTGenerateSplat(Session session, string[] imagesBase64, string filenamePrefix = "output", string outputFormat = "ply", bool padToSquare = false)
    {
        if (imagesBase64 is null || imagesBase64.Length == 0)
        {
            return new JObject { ["success"] = false, ["error"] = "No images provided." };
        }

        List<byte[]> imageBytesList = [];
        for (int i = 0; i < imagesBase64.Length; i++)
        {
            if (string.IsNullOrWhiteSpace(imagesBase64[i]))
            {
                return new JObject { ["success"] = false, ["error"] = $"Image at index {i} is empty." };
            }
            try
            {
                imageBytesList.Add(Convert.FromBase64String(imagesBase64[i]));
            }
            catch (FormatException)
            {
                return new JObject { ["success"] = false, ["error"] = $"Invalid base64 data at image index {i}." };
            }
        }

        (string outputFormatSanitized, string safePrefix, string outputFilename, string outputPath) =
            PrepareUniqueOutputPath(session, filenamePrefix, outputFormat);
        outputFormat = outputFormatSanitized;

        await EnsureDependenciesAsync();

        string tempRoot = Path.Combine(Path.GetTempPath(), $"sharpsplat_vggt_{Guid.NewGuid():N}");
        string inputDir = Path.Combine(tempRoot, "images");
        string outputDir = Path.Combine(tempRoot, "output");

        try
        {
            Directory.CreateDirectory(inputDir);
            Directory.CreateDirectory(outputDir);

            // Write each image to the temp input directory.
            for (int i = 0; i < imageBytesList.Count; i++)
            {
                string imgPath = Path.Combine(inputDir, $"image_{i:D4}.png");
                await File.WriteAllBytesAsync(imgPath, imageBytesList[i]);
            }

            string wrapperScript = Path.GetFullPath($"{SharpSplatExtension.ExtFolder}/run_vggt.py");
            ProcessStartInfo psi = BuildPythonPsi();
            psi.ArgumentList.Add("-s");
            psi.ArgumentList.Add(wrapperScript);
            psi.ArgumentList.Add("--image_dir");
            psi.ArgumentList.Add(inputDir);
            psi.ArgumentList.Add("--output_dir");
            psi.ArgumentList.Add(outputDir);
            if (padToSquare)
            {
                psi.ArgumentList.Add("--pad_to_square");
            }

            Logs.Info($"SharpSplat: Running VGGT on {imageBytesList.Count} image(s)...");
            using Process process = Process.Start(psi);
            Task<string> stdoutTask = process.StandardOutput.ReadToEndAsync();
            Task<string> stderrTask = process.StandardError.ReadToEndAsync();
            await process.WaitForExitAsync(CancellationToken.None);
            string stdout = (await stdoutTask).Trim();
            string stderr = (await stderrTask).Trim();

            if (!string.IsNullOrWhiteSpace(stdout))
            {
                Logs.Debug($"SharpSplat VGGT stdout: {stdout}");
            }
            if (!string.IsNullOrWhiteSpace(stderr))
            {
                Logs.Warning($"SharpSplat VGGT stderr: {stderr}");
            }

            if (process.ExitCode != 0)
            {
                string errMsg = string.IsNullOrWhiteSpace(stderr)
                    ? $"run_vggt exited with code {process.ExitCode}"
                    : stderr.Split('\n').Last(l => !string.IsNullOrWhiteSpace(l));
                Logs.Error($"SharpSplat: VGGT failed (exit {process.ExitCode}): {stderr}");
                return new JObject { ["success"] = false, ["error"] = $"VGGT failed: {errMsg}" };
            }

            string[] plyFiles = Directory.GetFiles(outputDir, "*.ply", SearchOption.AllDirectories);
            if (plyFiles.Length == 0)
            {
                Logs.Warning("SharpSplat: No .ply files found in VGGT output directory.");
                return new JObject { ["success"] = false, ["error"] = "VGGT produced no PLY output. Check server logs for details." };
            }

            string plyPath = plyFiles[0];

            if (outputFormat == "splat")
            {
                string convertScript = Path.GetFullPath($"{SharpSplatExtension.ExtFolder}/run_convert.py");
                ProcessStartInfo convertPsi = BuildPythonPsi();
                convertPsi.ArgumentList.Add("-s");
                convertPsi.ArgumentList.Add(convertScript);
                convertPsi.ArgumentList.Add(plyPath);
                convertPsi.ArgumentList.Add(outputPath);
                Logs.Info("SharpSplat: Converting VGGT PLY to .splat format...");
                using Process convertProcess = Process.Start(convertPsi);
                Task<string> convertOut = convertProcess.StandardOutput.ReadToEndAsync();
                Task<string> convertErr = convertProcess.StandardError.ReadToEndAsync();
                await convertProcess.WaitForExitAsync(CancellationToken.None);
                if (!string.IsNullOrWhiteSpace((await convertOut).Trim()))
                {
                    Logs.Debug($"SharpSplat convert stdout: {(await convertOut).Trim()}");
                }
                if (convertProcess.ExitCode != 0)
                {
                    string convertErrStr = (await convertErr).Trim();
                    Logs.Error($"SharpSplat: ply2splat conversion failed (exit {convertProcess.ExitCode}): {convertErrStr}");
                    return new JObject { ["success"] = false, ["error"] = $"PLY to .splat conversion failed: {convertErrStr}" };
                }
                if (!File.Exists(outputPath))
                {
                    Logs.Error("SharpSplat: ply2splat reported success but output file does not exist.");
                    return new JObject { ["success"] = false, ["error"] = "PLY to .splat conversion produced no output file." };
                }
            }
            else
            {
                File.Copy(plyPath, outputPath, overwrite: false);
                if (!File.Exists(outputPath))
                {
                    Logs.Error("SharpSplat: VGGT PLY copy failed — output file does not exist.");
                    return new JObject { ["success"] = false, ["error"] = "Failed to save VGGT PLY output file." };
                }
            }

            string outputUrl = $"/View/{Uri.EscapeDataString(session.User.UserID)}/splats/{Uri.EscapeDataString(outputFilename)}";
            long outputBytes = new FileInfo(outputPath).Length;
            Logs.Info($"SharpSplat: VGGT produced '{outputFilename}' ({outputBytes} bytes) at {outputUrl}.");
            return new JObject
            {
                ["success"] = true,
                ["splatUrl"] = outputUrl,
                ["filename"] = outputFilename
            };
        }
        catch (Exception ex)
        {
            Logs.Error($"SharpSplat VGGT error: {ex.Message}");
            return new JObject { ["success"] = false, ["error"] = ex.Message };
        }
        finally
        {
            try
            {
                if (Directory.Exists(tempRoot))
                {
                    Directory.Delete(tempRoot, recursive: true);
                }
            }
            catch
            {
                // Best-effort cleanup.
            }
        }
    }

    /// <summary>
    /// Generates a Gaussian splat PLY via the <c>InstantSplatGenerate</c> ComfyUI custom node.
    /// Submits a single-node workflow through the Comfy backend queue so InstantSplat shares
    /// the backend's VRAM slot and does not run while other generations are in progress.
    /// </summary>
    /// <param name="session">The calling user session.</param>
    /// <param name="imagesBase64">Array of base64-encoded image data (PNG/JPG/WEBP).</param>
    /// <param name="filenamePrefix">Optional filename prefix for the output file.</param>
    /// <param name="outputFormat">Output format: "ply" or "splat".</param>
    public static async Task<JObject> InstantSplatGenerateSplatViaComfy(Session session, string[] imagesBase64, string filenamePrefix = "output", string outputFormat = "ply", bool padToSquare = false)
    {
        if (imagesBase64 is null || imagesBase64.Length == 0)
        {
            return new JObject { ["success"] = false, ["error"] = "No images provided." };
        }
        foreach (string b64 in imagesBase64)
        {
            if (string.IsNullOrWhiteSpace(b64))
            {
                return new JObject { ["success"] = false, ["error"] = "One or more images in the array is empty." };
            }
            try { Convert.FromBase64String(b64); }
            catch (FormatException)
            {
                return new JObject { ["success"] = false, ["error"] = "Invalid base64 data in images array." };
            }
        }
        (string outputFormatSanitized, string safePrefix, string outputFilename, string outputPath) =
            PrepareUniqueOutputPath(session, filenamePrefix, outputFormat);
        outputFormat = outputFormatSanitized;
        string imagesJson = new JArray(imagesBase64.Cast<object>().ToArray()).ToString(Newtonsoft.Json.Formatting.None);
        JObject workflow = new()
        {
            ["1"] = new JObject
            {
                ["class_type"] = "InstantSplatGenerate",
                ["inputs"] = new JObject
                {
                    ["images_base64_json"] = imagesJson,
                    ["output_path"] = outputPath,
                    ["output_format"] = outputFormat,
                    ["pad_to_square"] = padToSquare
                }
            }
        };
        try
        {
            Logs.Info($"SharpSplat: Submitting InstantSplat generation via ComfyUI backend for '{safePrefix}' ({imagesBase64.Length} image(s))...");
            using Session.GenClaim claim = session.Claim(liveGens: 1);
            await ComfyUIBackendExtension.RunArbitraryWorkflowOnFirstBackend(workflow.ToString(), _ => { });
        }
        catch (Exception ex)
        {
            Logs.Error($"SharpSplat: InstantSplat ComfyUI workflow error: {ex.Message}");
            return new JObject { ["success"] = false, ["error"] = $"ComfyUI workflow failed: {ex.Message}" };
        }
        if (!File.Exists(outputPath))
        {
            Logs.Error($"SharpSplat: InstantSplat ComfyUI workflow completed but output file not found at '{outputPath}'.");
            return new JObject { ["success"] = false, ["error"] = "Workflow completed but output file was not produced. Check server logs." };
        }
        string outputUrl = $"/View/{Uri.EscapeDataString(session.User.UserID)}/splats/{Uri.EscapeDataString(outputFilename)}";
        long outputBytes = new FileInfo(outputPath).Length;
        Logs.Info($"SharpSplat: InstantSplat (Comfy) produced '{outputFilename}' ({outputBytes} bytes) at {outputUrl}.");
        return new JObject
        {
            ["success"] = true,
            ["splatUrl"] = outputUrl,
            ["filename"] = outputFilename
        };
    }

    /// <summary>
    /// Generates a Gaussian splat PLY file from one or more base64-encoded images using
    /// InstantSplat via a direct Python subprocess. Used as a fallback when no ComfyUI
    /// backend is available.
    /// </summary>
    /// <param name="session">The calling user session.</param>
    /// <param name="imagesBase64">Array of base64-encoded image data (PNG/JPG/WEBP).</param>
    /// <param name="filenamePrefix">Optional filename prefix for the output file.</param>
    /// <param name="outputFormat">Output format: "ply" or "splat".</param>
    public static async Task<JObject> InstantSplatGenerateSplat(Session session, string[] imagesBase64, string filenamePrefix = "output", string outputFormat = "ply", bool padToSquare = false)
    {
        if (imagesBase64 is null || imagesBase64.Length == 0)
        {
            return new JObject { ["success"] = false, ["error"] = "No images provided." };
        }

        List<byte[]> imageBytesList = [];
        for (int i = 0; i < imagesBase64.Length; i++)
        {
            if (string.IsNullOrWhiteSpace(imagesBase64[i]))
            {
                return new JObject { ["success"] = false, ["error"] = $"Image at index {i} is empty." };
            }
            try
            {
                imageBytesList.Add(Convert.FromBase64String(imagesBase64[i]));
            }
            catch (FormatException)
            {
                return new JObject { ["success"] = false, ["error"] = $"Invalid base64 data at image index {i}." };
            }
        }

        (string outputFormatSanitized, string safePrefix, string outputFilename, string outputPath) =
            PrepareUniqueOutputPath(session, filenamePrefix, outputFormat);
        outputFormat = outputFormatSanitized;

        await EnsureDependenciesAsync();

        string tempRoot = Path.Combine(Path.GetTempPath(), $"sharpsplat_instantsplat_{Guid.NewGuid():N}");
        string inputDir = Path.Combine(tempRoot, "images");
        string outputDir = Path.Combine(tempRoot, "output");

        try
        {
            Directory.CreateDirectory(inputDir);
            Directory.CreateDirectory(outputDir);

            for (int i = 0; i < imageBytesList.Count; i++)
            {
                string imgPath = Path.Combine(inputDir, $"image_{i:D4}.png");
                await File.WriteAllBytesAsync(imgPath, imageBytesList[i]);
            }

            string wrapperScript = Path.GetFullPath($"{SharpSplatExtension.ExtFolder}/run_instantsplat.py");
            ProcessStartInfo psi = BuildPythonPsi();
            psi.ArgumentList.Add("-s");
            psi.ArgumentList.Add(wrapperScript);
            psi.ArgumentList.Add("--image_dir");
            psi.ArgumentList.Add(inputDir);
            psi.ArgumentList.Add("--output_dir");
            psi.ArgumentList.Add(outputDir);
            if (padToSquare)
            {
                psi.ArgumentList.Add("--pad_to_square");
            }

            Logs.Info($"SharpSplat: Running InstantSplat on {imageBytesList.Count} image(s)...");
            using Process process = Process.Start(psi);
            Task<string> stdoutTask = process.StandardOutput.ReadToEndAsync();
            Task<string> stderrTask = process.StandardError.ReadToEndAsync();
            await process.WaitForExitAsync(CancellationToken.None);
            string stdout = (await stdoutTask).Trim();
            string stderr = (await stderrTask).Trim();

            if (!string.IsNullOrWhiteSpace(stdout))
            {
                Logs.Debug($"SharpSplat InstantSplat stdout: {stdout}");
            }
            if (!string.IsNullOrWhiteSpace(stderr))
            {
                Logs.Warning($"SharpSplat InstantSplat stderr: {stderr}");
            }

            if (process.ExitCode != 0)
            {
                string errMsg = string.IsNullOrWhiteSpace(stderr)
                    ? $"run_instantsplat exited with code {process.ExitCode}"
                    : stderr.Split('\n').Last(l => !string.IsNullOrWhiteSpace(l));
                Logs.Error($"SharpSplat: InstantSplat failed (exit {process.ExitCode}): {stderr}");
                return new JObject { ["success"] = false, ["error"] = $"InstantSplat failed: {errMsg}" };
            }

            string[] plyFiles = Directory.GetFiles(outputDir, "*.ply", SearchOption.AllDirectories);
            if (plyFiles.Length == 0)
            {
                Logs.Warning("SharpSplat: No .ply files found in InstantSplat output directory.");
                return new JObject { ["success"] = false, ["error"] = "InstantSplat produced no PLY output. Check server logs for details." };
            }

            string plyPath = plyFiles[0];

            if (outputFormat == "splat")
            {
                string convertScript = Path.GetFullPath($"{SharpSplatExtension.ExtFolder}/run_convert.py");
                ProcessStartInfo convertPsi = BuildPythonPsi();
                convertPsi.ArgumentList.Add("-s");
                convertPsi.ArgumentList.Add(convertScript);
                convertPsi.ArgumentList.Add(plyPath);
                convertPsi.ArgumentList.Add(outputPath);
                Logs.Info("SharpSplat: Converting InstantSplat PLY to .splat format...");
                using Process convertProcess = Process.Start(convertPsi);
                Task<string> convertOut = convertProcess.StandardOutput.ReadToEndAsync();
                Task<string> convertErr = convertProcess.StandardError.ReadToEndAsync();
                await convertProcess.WaitForExitAsync(CancellationToken.None);
                if (!string.IsNullOrWhiteSpace((await convertOut).Trim()))
                {
                    Logs.Debug($"SharpSplat convert stdout: {(await convertOut).Trim()}");
                }
                if (convertProcess.ExitCode != 0)
                {
                    string convertErrStr = (await convertErr).Trim();
                    Logs.Error($"SharpSplat: ply2splat conversion failed (exit {convertProcess.ExitCode}): {convertErrStr}");
                    return new JObject { ["success"] = false, ["error"] = $"PLY to .splat conversion failed: {convertErrStr}" };
                }
                if (!File.Exists(outputPath))
                {
                    Logs.Error("SharpSplat: ply2splat reported success but output file does not exist.");
                    return new JObject { ["success"] = false, ["error"] = "PLY to .splat conversion produced no output file." };
                }
            }
            else
            {
                File.Copy(plyPath, outputPath, overwrite: false);
                if (!File.Exists(outputPath))
                {
                    Logs.Error("SharpSplat: InstantSplat PLY copy failed — output file does not exist.");
                    return new JObject { ["success"] = false, ["error"] = "Failed to save InstantSplat PLY output file." };
                }
            }

            string outputUrl = $"/View/{Uri.EscapeDataString(session.User.UserID)}/splats/{Uri.EscapeDataString(outputFilename)}";
            long outputBytes = new FileInfo(outputPath).Length;
            Logs.Info($"SharpSplat: InstantSplat produced '{outputFilename}' ({outputBytes} bytes) at {outputUrl}.");
            return new JObject
            {
                ["success"] = true,
                ["splatUrl"] = outputUrl,
                ["filename"] = outputFilename
            };
        }
        catch (Exception ex)
        {
            Logs.Error($"SharpSplat InstantSplat error: {ex.Message}");
            return new JObject { ["success"] = false, ["error"] = ex.Message };
        }
        finally
        {
            try
            {
                if (Directory.Exists(tempRoot))
                {
                    Directory.Delete(tempRoot, recursive: true);
                }
            }
            catch
            {
                // Best-effort cleanup.
            }
        }
    }

    /// <summary>
    /// Returns a list of .splat files previously generated for this user,
    /// ordered newest-first, for display in the Splat Viewer tab sidebar.
    /// </summary>
    /// <param name="session">The calling user session.</param>
    public static Task<JObject> SharpListSplats(Session session)
    {
        string splatsDir = Path.Combine(WebServer.GetUserOutputRoot(session.User), "splats");
        if (!Directory.Exists(splatsDir))
        {
            return Task.FromResult(new JObject { ["success"] = true, ["splats"] = new JArray() });
        }
        string[] files = Directory.GetFiles(splatsDir)
            .Where(f => f.EndsWith(".splat", StringComparison.OrdinalIgnoreCase) || f.EndsWith(".ply", StringComparison.OrdinalIgnoreCase))
            .OrderByDescending(f => File.GetLastWriteTimeUtc(f))
            .ToArray();
        JArray arr = new();
        foreach (string f in files)
        {
            string fn = Path.GetFileName(f);
            arr.Add(new JObject
            {
                ["filename"] = fn,
                ["url"] = $"/View/{Uri.EscapeDataString(session.User.UserID)}/splats/{Uri.EscapeDataString(fn)}"
            });
        }
        return Task.FromResult(new JObject { ["success"] = true, ["splats"] = arr });
    }

    /// <summary>
    /// Deletes a previously generated .splat file for this user.
    /// </summary>
    /// <param name="session">The calling user session.</param>
    /// <param name="filename">The filename (basename only, no path) of the .splat file to delete.</param>
    public static Task<JObject> SharpDeleteSplat(Session session, string filename)
    {
        // Accept only a safe bare filename — no path separators or traversal sequences.
        string safeFilename = string.Concat(
            (filename ?? "")
                .Where(c => char.IsLetterOrDigit(c) || c == '-' || c == '_' || c == '.' || c == ' '));
        bool validExtension = safeFilename.EndsWith(".splat", StringComparison.OrdinalIgnoreCase)
            || safeFilename.EndsWith(".ply", StringComparison.OrdinalIgnoreCase);
        if (string.IsNullOrWhiteSpace(safeFilename) || !validExtension)
        {
            return Task.FromResult(new JObject { ["success"] = false, ["error"] = "Invalid filename." });
        }
        string splatsDir = Path.Combine(WebServer.GetUserOutputRoot(session.User), "splats");
        string splatPath = Path.Combine(splatsDir, safeFilename);
        // Confirm the resolved path is still inside the user's splats directory.
        if (!Path.GetFullPath(splatPath).StartsWith(Path.GetFullPath(splatsDir) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
        {
            return Task.FromResult(new JObject { ["success"] = false, ["error"] = "Invalid filename." });
        }
        if (!File.Exists(splatPath))
        {
            return Task.FromResult(new JObject { ["success"] = false, ["error"] = "File not found." });
        }
        File.Delete(splatPath);
        Logs.Info($"SharpSplat: Deleted splat '{safeFilename}' for user '{session.User.UserID}'.");
        return Task.FromResult(new JObject { ["success"] = true });
    }

    /// <summary>
    /// Saves a base64-encoded PNG image captured from the canvas to
    /// <c>Output/local/splats_export/</c> with the provided filename.
    /// </summary>
    /// <param name="session">The calling user session.</param>
    /// <param name="imageBase64">Base64-encoded PNG image data.</param>
    /// <param name="filename">Desired output filename (e.g. "mysplat_20260509T120000.png").</param>
    public static async Task<JObject> SharpSaveCanvasExport(Session session, string imageBase64, string filename)
    {
        if (string.IsNullOrWhiteSpace(imageBase64))
        {
            return new JObject { ["success"] = false, ["error"] = "No image data provided." };
        }
        // Sanitise the filename to only safe characters and enforce .png extension.
        string rawBase = filename ?? "canvas_export";
        // Strip any extension the caller supplied — we always save as .png.
        int dotIdx = rawBase.LastIndexOf('.');
        if (dotIdx > 0)
        {
            rawBase = rawBase[..dotIdx];
        }
        string safeBase = string.Concat(rawBase.Where(c => char.IsLetterOrDigit(c) || c == '-' || c == '_'));
        if (string.IsNullOrWhiteSpace(safeBase))
        {
            safeBase = "canvas_export";
        }
        string safeFilename = safeBase + ".png";
        byte[] imageBytes;
        try
        {
            imageBytes = Convert.FromBase64String(imageBase64);
        }
        catch (FormatException)
        {
            return new JObject { ["success"] = false, ["error"] = "Invalid base64 image data." };
        }
        string exportDir = Path.Combine(WebServer.GetUserOutputRoot(session.User), "splats_export");
        Directory.CreateDirectory(exportDir);
        string outputPath = Path.Combine(exportDir, safeFilename);
        // Deduplicate by appending a counter if the file already exists.
        int counter = 0;
        while (File.Exists(outputPath))
        {
            counter++;
            outputPath = Path.Combine(exportDir, $"{safeBase}_{counter}.png");
            safeFilename = Path.GetFileName(outputPath);
        }
        // Confirm the resolved path is still inside the export directory.
        if (!Path.GetFullPath(outputPath).StartsWith(Path.GetFullPath(exportDir) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
        {
            return new JObject { ["success"] = false, ["error"] = "Invalid filename." };
        }
        await File.WriteAllBytesAsync(outputPath, imageBytes);
        Logs.Info($"SharpSplat: Canvas export saved to '{outputPath}' ({imageBytes.Length} bytes).");
        return new JObject { ["success"] = true, ["filename"] = safeFilename };
    }
}
