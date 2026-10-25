using NuGet.Packaging;
using System.Text.Json;

if (args.Length != 2) throw new ArgumentException("Expected package-list JSON and verification-output JSON.");
var packages = JsonSerializer.Deserialize<List<Package>>(File.ReadAllText(args[0]))!;
var output = new List<object>();
foreach (var package in packages)
{
    using var reader = new PackageArchiveReader(package.file);
    string contentHash = reader.GetContentHash(CancellationToken.None);
    if (contentHash != package.expectedContentHash)
        throw new InvalidDataException($"NuGet content hash mismatch: {package.id}");
    bool signed = await reader.IsSignedAsync(CancellationToken.None);
    if (signed)
    {
        var signature = await reader.GetPrimarySignatureAsync(CancellationToken.None);
        await reader.ValidateIntegrityAsync(signature!.SignatureContent, CancellationToken.None);
    }
    output.Add(new { package.id, contentHash, signed, integrityVerified = true });
}
File.WriteAllText(args[1], JsonSerializer.Serialize(output));

record Package(string id, string file, string expectedContentHash);
