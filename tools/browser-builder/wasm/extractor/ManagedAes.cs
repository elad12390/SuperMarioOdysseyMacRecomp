using System.Security.Cryptography;
using Org.BouncyCastle.Crypto;
using Org.BouncyCastle.Crypto.Engines;
using Org.BouncyCastle.Crypto.Modes;
using Org.BouncyCastle.Crypto.Parameters;

namespace SwitchRecomp.Browser;

// LibHac's original AES modes and storage implementations remain unchanged.
// Its fallback Aes.Create() is platform-unsupported in browsers; this provider
// implements that same ECB/CBC transform contract with managed Bouncy Castle.
public sealed class ManagedAes : Aes
{
    public ManagedAes()
    {
        LegalKeySizesValue = [new KeySizes(128, 256, 64)];
        LegalBlockSizesValue = [new KeySizes(128, 128, 0)];
        BlockSizeValue = 128;
        KeySizeValue = 128;
        ModeValue = CipherMode.ECB;
        PaddingValue = PaddingMode.None;
    }

    public new static Aes Create() => new ManagedAes();
    public override void GenerateIV() => IVValue = RandomNumberGenerator.GetBytes(16);
    public override void GenerateKey() => KeyValue = RandomNumberGenerator.GetBytes(KeySize / 8);
    public override ICryptoTransform CreateEncryptor() => Transform(Key, Mode == CipherMode.CBC ? IV : null, true);
    public override ICryptoTransform CreateDecryptor() => Transform(Key, Mode == CipherMode.CBC ? IV : null, false);
    public override ICryptoTransform CreateEncryptor(byte[] key, byte[]? iv) => Transform(key, iv, true);
    public override ICryptoTransform CreateDecryptor(byte[] key, byte[]? iv) => Transform(key, iv, false);

    private ICryptoTransform Transform(byte[] key, byte[]? iv, bool encrypt)
    {
        if (Padding != PaddingMode.None || (Mode != CipherMode.ECB && Mode != CipherMode.CBC))
            throw new NotSupportedException("Unsupported LibHac AES transform mode.");
        IBlockCipher cipher = new AesEngine();
        ICipherParameters parameters = new KeyParameter(key);
        if (Mode == CipherMode.CBC)
        {
            cipher = new CbcBlockCipher(cipher);
            parameters = new ParametersWithIV(parameters, iv ?? throw new ArgumentNullException(nameof(iv)));
        }
        cipher.Init(encrypt, parameters);
        return new BlockTransform(cipher);
    }

    private sealed class BlockTransform(IBlockCipher cipher) : ICryptoTransform
    {
        private IBlockCipher? _cipher = cipher;
        public bool CanReuseTransform => false;
        public bool CanTransformMultipleBlocks => true;
        public int InputBlockSize => 16;
        public int OutputBlockSize => 16;
        public int TransformBlock(byte[] input, int offset, int count, byte[] output, int outputOffset)
        {
            if (count < 0 || count % 16 != 0) throw new CryptographicException("AES requires complete blocks.");
            for (int done = 0; done < count; done += 16)
                (_cipher ?? throw new ObjectDisposedException(nameof(BlockTransform))).ProcessBlock(input, offset + done, output, outputOffset + done);
            return count;
        }
        public byte[] TransformFinalBlock(byte[] input, int offset, int count)
        {
            byte[] output = new byte[count];
            TransformBlock(input, offset, count, output, 0);
            return output;
        }
        public void Dispose() => _cipher = null;
    }

    // NIST SP 800-38A F.1 / F.2 first-block known answers, in both directions.
    public static bool KnownAnswers()
    {
        byte[] plain = Convert.FromHexString("6bc1bee22e409f96e93d7e117393172a");
        var vectors = new[] {
            (CipherMode.ECB, "2b7e151628aed2a6abf7158809cf4f3c", "3ad77bb40d7a3660a89ecaf32466ef97"),
            (CipherMode.ECB, "603deb1015ca71be2b73aef0857d77811f352c073b6108d72d9810a30914dff4", "f3eed1bdb5d2a03c064b5a7e3db181f8"),
            (CipherMode.CBC, "2b7e151628aed2a6abf7158809cf4f3c", "7649abac8119b246cee98e9b12e9197d")
        };
        foreach (var (mode, keyText, expectedText) in vectors)
        {
            using var aes = new ManagedAes { Mode = mode };
            byte[] key = Convert.FromHexString(keyText), expected = Convert.FromHexString(expectedText);
            byte[] iv = Convert.FromHexString("000102030405060708090a0b0c0d0e0f");
            using var encrypt = aes.CreateEncryptor(key, iv);
            using var decrypt = aes.CreateDecryptor(key, iv);
            if (!encrypt.TransformFinalBlock(plain, 0, 16).AsSpan().SequenceEqual(expected) ||
                !decrypt.TransformFinalBlock(expected, 0, 16).AsSpan().SequenceEqual(plain)) return false;
            aes.Key = key; aes.IV = iv;
            using var defaultEncrypt = aes.CreateEncryptor();
            using var defaultDecrypt = aes.CreateDecryptor();
            if (!defaultEncrypt.TransformFinalBlock(plain, 0, 16).AsSpan().SequenceEqual(expected) ||
                !defaultDecrypt.TransformFinalBlock(expected, 0, 16).AsSpan().SequenceEqual(plain)) return false;
        }
        return true;
    }
}
