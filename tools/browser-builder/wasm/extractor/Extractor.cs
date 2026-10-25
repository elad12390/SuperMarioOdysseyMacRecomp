using System.Runtime.InteropServices.JavaScript;
using System.Buffers.Binary;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using LibHac.Common;
using LibHac.Common.Keys;
using LibHac.Fs;
using LibHac.Fs.Fsa;
using LibHac.FsSystem;
using LibHac.Spl;
using LibHac.Tools.Fs;
using LibHac.Tools.FsSystem;
using LibHac.Tools.FsSystem.NcaUtils;
using LibHac.Tools.FsSystem.RomFs;

namespace SwitchRecomp.Browser;

public sealed record ExtractionInfo(string TitleId, string Version, string MainBuildId, bool Supported);
public sealed record OutputEntry(string Path, long Size);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(ExtractionInfo))]
[JsonSerializable(typeof(OutputEntry))]
internal partial class ExtractorJson : JsonSerializerContext;

public static partial class Extractor
{
    // Pinned to the base v0 profile in dm/games/0100000000010000/game.tsv.
    private const ulong SupportedTitle = 0x0100000000010000;
    private const string SupportedMain = "3ca12dfaaf9c82da064d1698df79cda1";
    private static readonly string[] IconLanguages = [
        "AmericanEnglish", "BritishEnglish", "Japanese", "French", "German", "LatinAmericanSpanish", "Spanish", "Italian",
        "Dutch", "CanadianFrench", "Portuguese", "Russian", "Korean", "TraditionalChinese", "SimplifiedChinese", "BrazilianPortuguese"
    ];
    private static BrowserStorage? _input;
    private static PartitionFileSystem? _package;
    private static IFileSystem? _code;
    private static IFileSystem? _data;
    private static IFileSystem? _control;
    private static readonly List<IStorage> NcaStorages = [];
    private static IEnumerator<(IFileSystem Fs, string Source, OutputEntry Output)>? _entries;
    private static UniqueRef<IFile> _file;
    private static long _offset;
    private static long _size;
    private static readonly byte[] Buffer = new byte[BrowserStorage.ChunkSize];
    private static string _stage = "idle";
    private static string _diagnostic = "";

    public static void Main() { }

    [JSExport]
    public static string Open(double size, string prodKeys, string titleKeys, bool includeRomFs)
    {
        _diagnostic = "";
        try { return OpenCore(size, prodKeys, titleKeys, includeRomFs); }
        catch (Exception error)
        {
            _diagnostic = _stage + ":" + error.GetType().Name + ":" + error.InnerException?.GetType().Name;
            string[] codes = ["TRUNCATED_INPUT", "UNSUPPORTED_TITLE", "UNSUPPORTED_BUILD", "INVALID_MAIN", "MISSING_CONTROL"];
            throw new InvalidDataException(codes.Contains(error.Message) ? error.Message : "EXTRACT_FAILED");
        }
    }

    [JSExport]
    public static string GetLastDiagnostic() => _diagnostic;

    [JSExport]
    public static bool CryptoKnownAnswers() => ManagedAes.KnownAnswers();

    private static string OpenCore(double size, string prodKeys, string titleKeys, bool includeRomFs)
    {
        Close();
        if (!double.IsInteger(size) || size < 16 || size > 9007199254740991d)
            throw new InvalidDataException("TRUNCATED_INPUT");
        _input = new BrowserStorage((long)size);
        _stage = "package-bounds";
        ValidatePackage(_input, (long)size);
        _stage = "keys";
        KeySet keys;
        // LibHac's public filename API supplies its internal default key list.
        // These two bounded files exist only in the WASM virtual filesystem,
        // are unlinked immediately, and are never written to OPFS.
        try
        {
            File.WriteAllText("/extractor-prod.keys", prodKeys);
            if (titleKeys.Length > 0) File.WriteAllText("/extractor-title.keys", titleKeys);
            keys = ExternalKeyReader.ReadKeyFile("/extractor-prod.keys", titleKeys.Length > 0 ? "/extractor-title.keys" : null);
        }
        finally
        {
            File.Delete("/extractor-prod.keys");
            File.Delete("/extractor-title.keys");
        }
        _package = new PartitionFileSystem();
        _stage = "pfs0";
        _package.Initialize(_input).ThrowIfFailure();
        var packageEntries = _package.EnumerateEntries("*", SearchOptions.Default).ToList();
        // Tickets must be imported before any rights-protected NCA is opened.
        foreach (var entry in packageEntries.Where(e => e.Name.EndsWith(".tik", StringComparison.OrdinalIgnoreCase)))
        {
            using var file = new UniqueRef<IFile>();
            _package.OpenFile(ref file.Ref, entry.FullPath.ToU8Span(), OpenMode.Read).ThrowIfFailure();
            byte[] ticket = new byte[0x2c0];
            ReadExactly(file.Get, 0, ticket);
            if (ticket[0x281] == 0)
                keys.ExternalKeySet.Add(new RightsId(ticket.AsSpan(0x2a0, 16)), new AccessKey(ticket.AsSpan(0x180, 16))).ThrowIfFailure();
        }
        var ncas = new List<Nca>();
        _stage = "nca-headers";
        foreach (var entry in packageEntries.Where(e => e.Name.EndsWith(".nca", StringComparison.OrdinalIgnoreCase)))
        {
            using var file = new UniqueRef<IFile>();
            _package.OpenFile(ref file.Ref, entry.FullPath.ToU8Span(), OpenMode.Read).ThrowIfFailure();
            var storage = file.Release().AsStorage();
            NcaStorages.Add(storage);
            ncas.Add(new Nca(keys, storage));
        }
        var programs = ncas.Where(n => n.Header.ContentType == NcaContentType.Program).ToList();
        if (programs.Count != 1 || programs[0].Header.TitleId != SupportedTitle)
            throw new InvalidDataException("UNSUPPORTED_TITLE");
        var program = programs[0];
        _stage = "exefs";
        _code = program.OpenFileSystem(NcaSectionType.Code, IntegrityCheckLevel.ErrorOnInvalid);
        using (var main = new UniqueRef<IFile>())
        {
            _code.OpenFile(ref main.Ref, "/main".ToU8Span(), OpenMode.Read).ThrowIfFailure();
            byte[] header = new byte[0x100];
            ReadExactly(main.Get, 0, header);
            if (!header.AsSpan(0, 4).SequenceEqual("NSO0"u8)) throw new InvalidDataException("INVALID_MAIN");
            string build = Convert.ToHexString(header.AsSpan(0x40, 32)).ToLowerInvariant();
            if (build[..32] != SupportedMain || header.AsSpan(0x50, 16).IndexOfAnyExcept((byte)0) >= 0)
                throw new InvalidDataException("UNSUPPORTED_BUILD");
            var controlNca = ncas.SingleOrDefault(n => n.Header.ContentType == NcaContentType.Control && n.Header.TitleId == SupportedTitle)
                ?? throw new InvalidDataException("MISSING_CONTROL");
            _stage = "control";
            _control = controlNca.OpenFileSystem(NcaSectionType.Data, IntegrityCheckLevel.ErrorOnInvalid);
            using var nacp = new UniqueRef<IFile>();
            _control.OpenFile(ref nacp.Ref, "/control.nacp".ToU8Span(), OpenMode.Read).ThrowIfFailure();
            byte[] control = new byte[0x4000];
            ReadExactly(nacp.Get, 0, control);
            string version = Encoding.ASCII.GetString(control, 0x3060, 0x10).TrimEnd('\0');
            if (version != "1.0.0") throw new InvalidDataException("UNSUPPORTED_BUILD");
            if (includeRomFs)
            {
                _stage = "romfs";
                _data = new RomFsFileSystem(program.OpenStorage(NcaSectionType.Data, IntegrityCheckLevel.ErrorOnInvalid));
            }
            _entries = EnumerateOutputs().GetEnumerator();
            return JsonSerializer.Serialize(new ExtractionInfo($"{SupportedTitle:x16}", version, build, true), ExtractorJson.Default.ExtractionInfo);
        }
    }

    private static void ValidatePackage(IStorage input, long size)
    {
        Span<byte> header = stackalloc byte[16];
        input.Read(0, header).ThrowIfFailure();
        if (!header[..4].SequenceEqual("PFS0"u8)) throw new InvalidDataException("TRUNCATED_INPUT");
        int count = BinaryPrimitives.ReadInt32LittleEndian(header[4..]);
        int strings = BinaryPrimitives.ReadInt32LittleEndian(header[8..]);
        if (count < 1 || count > 4096 || strings < 1 || strings > (1 << 20))
            throw new InvalidDataException("TRUNCATED_INPUT");
        int tableSize = checked(count * 24 + strings);
        long dataOffset = 16L + tableSize;
        if (dataOffset > size) throw new InvalidDataException("TRUNCATED_INPUT");
        byte[] table = new byte[tableSize];
        input.Read(16, table).ThrowIfFailure();
        for (int i = 0; i < count; i++)
        {
            var entry = table.AsSpan(i * 24, 24);
            long offset = BinaryPrimitives.ReadInt64LittleEndian(entry);
            long length = BinaryPrimitives.ReadInt64LittleEndian(entry[8..]);
            int name = BinaryPrimitives.ReadInt32LittleEndian(entry[16..]);
            if (offset < 0 || offset > size - dataOffset || length < 0 || length > size - dataOffset - offset ||
                name < 0 || name >= strings || table.AsSpan(count * 24 + name).IndexOf((byte)0) < 0)
                throw new InvalidDataException("TRUNCATED_INPUT");
        }
    }

    private static IEnumerable<(IFileSystem, string, OutputEntry)> EnumerateOutputs()
    {
        // Root control data plus the same ExeFS/RomFS layout as nx_extract.
        yield return (_control!, "/control.nacp", new OutputEntry("control.nacp", 0x4000));
        if (FindControlIcon() is { } icon)
            yield return (_control!, icon.Path, new OutputEntry("icon.jpg", icon.Size));
        foreach (var (fs, prefix) in new[] { (_code, "ExeFS"), (_data, "RomFS") })
        {
            if (fs is null) continue;
            foreach (var entry in fs.EnumerateEntries("*", SearchOptions.RecurseSubdirectories))
                if (entry.Type == DirectoryEntryType.File)
                    yield return (fs, entry.FullPath, new OutputEntry(prefix + "/" + entry.FullPath.TrimStart('/'), entry.Size));
        }
    }

    private static (string Path, long Size)? FindControlIcon()
    {
        var files = _control!.EnumerateEntries("*", SearchOptions.Default)
            .Where(entry => entry.Type == DirectoryEntryType.File)
            .ToDictionary(entry => entry.Name, StringComparer.Ordinal);
        // Match nx_extract's preference order. No icon is also valid.
        foreach (string language in IconLanguages)
            if (files.TryGetValue($"icon_{language}.dat", out var icon))
                return (icon.FullPath, icon.Size);
        return null;
    }

    [JSExport]
    public static string NextFile()
    {
        _file.Destroy();
        if (_entries is null || !_entries.MoveNext()) return "";
        var entry = _entries.Current;
        entry.Fs.OpenFile(ref _file.Ref, entry.Source.ToU8Span(), OpenMode.Read).ThrowIfFailure();
        _offset = 0;
        _file.Get.GetSize(out _size).ThrowIfFailure();
        if (_size != entry.Output.Size) throw new InvalidDataException("INVALID_SIZE");
        return JsonSerializer.Serialize(entry.Output, ExtractorJson.Default.OutputEntry);
    }

    [JSExport]
    public static int CopyChunk()
    {
        if (_offset == _size) return 0;
        int want = (int)Math.Min(Buffer.Length, _size - _offset);
        ReadExactly(_file.Get, _offset, Buffer.AsSpan(0, want));
        if (BrowserIo.WriteOutput(_offset, Buffer.AsSpan(0, want)) != want)
            throw new IOException("OUTPUT_WRITE_FAILED");
        _offset += want;
        return want;
    }

    private static void ReadExactly(IFile file, long offset, Span<byte> buffer)
    {
        while (!buffer.IsEmpty)
        {
            file.Read(out long got, offset, buffer, ReadOption.None).ThrowIfFailure();
            if (got <= 0 || got > buffer.Length) throw new IOException("TRUNCATED_INPUT");
            offset += got;
            buffer = buffer[(int)got..];
        }
    }

    [JSExport]
    public static void Close()
    {
        _file.Destroy();
        _entries?.Dispose(); _entries = null;
        _control?.Dispose(); _control = null;
        _data?.Dispose(); _data = null;
        _code?.Dispose(); _code = null;
        foreach (var storage in NcaStorages) storage.Dispose();
        NcaStorages.Clear();
        _package?.Dispose(); _package = null;
        _input?.Dispose(); _input = null;
        Array.Clear(Buffer);
    }
}
