using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;
using SwarmUI.Accounts;
using SwarmUI.Utils;
using SwarmUI.WebAPI;

namespace SharpSplat;

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
    /// Generates a 3D Gaussian Splat PLY file from the provided base64-encoded image using ml-sharp.
    /// </summary>
    /// <param name="session">The calling user session.</param>
    /// <param name="imageBase64">Base64-encoded image data (PNG/JPG/WEBP).</param>
    /// <param name="filenamePrefix">Optional filename prefix to use for the output .splat file.</param>
    public static async Task<JObject> SharpGenerateSplat(Session session, string imageBase64, string filenamePrefix = "output")
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

        // Sanitize filenamePrefix: keep only safe characters, fall back to "output".
        string safePrefix = string.Concat(
            (filenamePrefix ?? "output")
                .Where(c => char.IsLetterOrDigit(c) || c == '-' || c == '_' || c == '.'));
        if (string.IsNullOrWhiteSpace(safePrefix))
        {
            safePrefix = "output";
        }

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

            // Convert PLY -> .splat using ply2splat (avoids property-type issues in browser viewers).
            string splatPath = Path.ChangeExtension(plyPath, ".splat");
            string convertScript = Path.GetFullPath($"{SharpSplatExtension.ExtFolder}/run_convert.py");
            ProcessStartInfo convertPsi = BuildPythonPsi();
            convertPsi.ArgumentList.Add("-s");
            convertPsi.ArgumentList.Add(convertScript);
            convertPsi.ArgumentList.Add(plyPath);
            convertPsi.ArgumentList.Add(splatPath);
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

            byte[] splatBytes = await File.ReadAllBytesAsync(splatPath);
            string splatBase64 = Convert.ToBase64String(splatBytes);
            string filename = $"{safePrefix}.splat";

            Logs.Info($"SharpSplat: Successfully produced .splat '{filename}' ({splatBytes.Length} bytes).");
            return new JObject
            {
                ["success"] = true,
                ["splatBase64"] = splatBase64,
                ["filename"] = filename
            };
        }
        catch (Exception ex)
        {
            Logs.Error($"SharpSplat error: {ex.Message}");
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
                // Best-effort cleanup; temp files are cleared on next OS restart anyway.
            }
        }
    }
}
