using System;
using System.Diagnostics.CodeAnalysis;
using System.IO;
using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using System.Text.Json.Nodes;

namespace BrowserShaders;

public static class Startup
{
    public static void Main() { }
}

[SupportedOSPlatform("browser")]
public static partial class ShaderTranslator
{
    static string diagnostics = "";

    static string InputPath(string path)
    {
        if (path == null || !path.StartsWith("/in/", StringComparison.Ordinal) ||
            path.Length <= 4 || path.AsSpan(4).IndexOfAny('/', '\\') >= 0 || path.Contains(".."))
            throw new ArgumentException("Shader input must be a file directly under /in/.");
        return path;
    }

    [JSExport]
    public static void WriteFile(string path, byte[] bytes)
    {
        InputPath(path);
        Directory.CreateDirectory("/in");
        File.WriteAllBytes(path, bytes);
    }

    [JSExport]
    public static byte[] ReadFile(string path)
    {
        if (path == null || !path.StartsWith("/out/", StringComparison.Ordinal) ||
            path.AsSpan(5).IndexOfAny('/', '\\') >= 0 || path.Contains(".."))
            throw new ArgumentException("Shader output must be a file directly under /out/.");
        return File.ReadAllBytes(path);
    }

    [JSExport]
    public static string GetDiagnostics() => diagnostics;

    [JSExport]
    public static void Reset()
    {
        foreach (string path in new[] { "/in", "/out" })
            if (Directory.Exists(path)) Directory.Delete(path, true);
        if (File.Exists("/jobs.json")) File.Delete("/jobs.json");
        diagnostics = "";
    }

    [JSExport]
    [DynamicDependency(DynamicallyAccessedMemberTypes.NonPublicMethods, typeof(SwshXlate))]
    public static int Translate(string jobsJson)
    {
        JsonArray jobs = JsonNode.Parse(jobsJson)?.AsArray() ?? throw new ArgumentException("Expected shader job array.");
        var keys = new System.Collections.Generic.HashSet<string>(StringComparer.Ordinal);
        foreach (JsonNode job in jobs)
        {
            string key = (string)job?["key"];
            if (string.IsNullOrEmpty(key) || key.Length > 128 || !keys.Add(key))
                throw new ArgumentException("Shader keys must be unique, nonempty and at most 128 characters.");
            foreach (char c in key)
                if (!(char.IsAsciiLetterOrDigit(c) || c == '_' || c == '-'))
                    throw new ArgumentException("Shader keys may contain ASCII letters, digits, underscore and hyphen.");
            string stage = (string)job["stage"];
            if (stage != "vs" && stage != "ps" && stage != "cs" && stage != "gs")
                throw new ArgumentException("Expected vs, ps, cs or gs shader stage.");
            string path = InputPath((string)job["code"]);
            if (!File.Exists(path)) throw new FileNotFoundException("Shader byte input was not supplied.", path);
        }
        if (Directory.Exists("/out")) Directory.Delete("/out", true);
        File.WriteAllText("/jobs.json", jobs.ToJsonString());
        var output = new StringWriter();
        TextWriter previousOut = Console.Out, previousError = Console.Error;
        Console.SetOut(output); Console.SetError(output);
        try
        {
            MethodInfo entry = typeof(SwshXlate).GetMethod("Main", BindingFlags.Static | BindingFlags.NonPublic)
                ?? throw new MissingMethodException("Original shader translator entry point was trimmed.");
            return (int)entry.Invoke(null, new object[] { new[] { "/jobs.json", "/out" } });
        }
        catch (TargetInvocationException error) when (error.InnerException != null)
        {
            ExceptionDispatchInfo.Capture(error.InnerException).Throw();
            throw;
        }
        finally
        {
            diagnostics = output.ToString();
            Console.SetOut(previousOut); Console.SetError(previousError);
            output.Dispose();
        }
    }
}
