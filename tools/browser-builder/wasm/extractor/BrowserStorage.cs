using LibHac;
using LibHac.Fs;
using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;

[assembly: SupportedOSPlatform("browser")]

namespace SwitchRecomp.Browser;

internal static partial class BrowserIo
{
    [JSImport("readInput", "browser-io")]
    internal static partial int ReadInput(double offset,
        [JSMarshalAs<JSType.MemoryView>] Span<byte> destination);

    [JSImport("writeOutput", "browser-io")]
    internal static partial int WriteOutput(double offset,
        [JSMarshalAs<JSType.MemoryView>] Span<byte> source);
}

// LibHac offsets remain Int64. Only exactly representable file offsets cross JS.
// Reads land directly in a bounded view of WASM memory, never in MEMFS.
internal sealed class BrowserStorage(long size) : IStorage
{
    public const int ChunkSize = 1 << 20;

    public override Result Read(long offset, Span<byte> destination)
    {
        if (offset < 0 || offset > size || destination.Length > size - offset)
            throw new IOException("TRUNCATED_INPUT");
        for (int done = 0; done < destination.Length;)
        {
            int count = Math.Min(ChunkSize, destination.Length - done);
            if (BrowserIo.ReadInput(offset + done, destination.Slice(done, count)) != count)
                throw new IOException("TRUNCATED_INPUT");
            done += count;
        }
        return Result.Success;
    }

    public override Result GetSize(out long output) { output = size; return Result.Success; }
    public override Result Flush() => Result.Success;
    public override Result SetSize(long value) => throw new NotSupportedException();
    public override Result Write(long offset, ReadOnlySpan<byte> source) => throw new NotSupportedException();
    public override Result OperateRange(Span<byte> output, OperationId id, long offset, long length, ReadOnlySpan<byte> input)
        => throw new NotSupportedException();
}
