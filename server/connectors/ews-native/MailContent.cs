using System.Security.Cryptography;
using System.Security.Cryptography.Pkcs;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using MimeKit;
using MimeKit.Cryptography;
using MimeKit.Text;
using MimeKit.Tnef;

namespace AnotherRae.Ews;

public static partial class MailContent {
    public const int MaximumMimeBytes = 16 * 1024 * 1024;
    public static (byte[] Content, string Kind) Unprotect(byte[] bytes, X509Certificate2Collection certificates) {
        if (bytes.Length > MaximumMimeBytes) throw new EwsFailure("response_limit");
        // IPM.Note.SMIME can also be opaque-signed, without encryption.
        try {
            var signed = new SignedCms(); signed.Decode(bytes);
            return (signed.ContentInfo.Content, "smime-signed-unverified");
        } catch (CryptographicException) { }
        var encrypted = new EnvelopedCms(); encrypted.Decode(bytes);
        if (encrypted.RecipientInfos.Count > 256) throw new EwsFailure("response_limit");
        if (certificates.Count == 0) throw new EwsFailure("certificate_missing");
        foreach (var certificate in certificates) {
            if (!certificate.HasPrivateKey) continue;
            using var key = certificate.GetRSAPrivateKey();
            if (key is null) continue;
            foreach (RecipientInfo recipient in encrypted.RecipientInfos) {
                try {
                    // This overload only uses the explicitly supplied private key;
                    // it never searches the machine/user certificate stores.
                    encrypted.Decrypt(recipient, key);
                    return (encrypted.ContentInfo.Content, "smime-decrypted");
                } catch (CryptographicException) { }
            }
        }
        throw new EwsFailure("decrypt");
    }

    public static string ReadText(byte[] bytes) {
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
        try {
            var visited = 0;
            return ReadBytes(bytes, 0, ref visited)?.Trim() ?? throw new EwsFailure("mime");
        } catch (EwsFailure) { throw; }
        catch { throw new EwsFailure("mime"); }
    }

    static string? ReadBytes(byte[] bytes, int depth, ref int visited) {
        if (bytes.Length > MaximumMimeBytes || depth > 8) throw new EwsFailure("response_limit");
        if (bytes.Length > 0 && bytes[0] == 0x30) {
            try {
                var signed = new SignedCms(); signed.Decode(bytes);
                return ReadBytes(signed.ContentInfo.Content, depth + 1, ref visited);
            } catch (CryptographicException) { }
        }
        using var stream = new MemoryStream(bytes, writable: false);
        using var entity = bytes.Length > 4 && bytes.AsSpan(0, 4).SequenceEqual(new byte[] { 0x78, 0x9f, 0x3e, 0x22 })
            ? MimeEntity.Load(new ContentType("application", "ms-tnef"), stream) : MimeEntity.Load(stream);
        return ReadEntity(entity, depth, ref visited);
    }

    static string? ReadEntity(MimeEntity entity, int depth, ref int visited) {
        if (depth > 8 || ++visited > 256) throw new EwsFailure("response_limit");
        if (entity is ApplicationPkcs7Mime pkcs7) {
            if (pkcs7.SecureMimeType != SecureMimeType.SignedData) throw new EwsFailure("mime");
            using var buffer = new MemoryStream();
            (pkcs7.Content ?? throw new EwsFailure("mime")).DecodeTo(buffer);
            if (buffer.Length > MaximumMimeBytes) throw new EwsFailure("response_limit");
            var signed = new SignedCms(); signed.Decode(buffer.ToArray());
            return ReadBytes(signed.ContentInfo.Content, depth + 1, ref visited);
        }
        if (entity is TnefPart tnef) {
            using var converted = tnef.ConvertToMessage();
            return ReadEntity(converted.Body ?? throw new EwsFailure("mime"), depth + 1, ref visited);
        }
        if (entity is TextPart text) return text.IsPlain ? text.Text : text.IsHtml ? PlainHtml(text.Text) : null;
        if (entity is Multipart multipart) {
            foreach (var part in multipart.OfType<TextPart>().Where(part => !part.IsAttachment && part.IsPlain)) {
                var value = ReadEntity(part, depth + 1, ref visited);
                if (!string.IsNullOrWhiteSpace(value)) return value;
            }
            foreach (var part in multipart.Where(part => !part.IsAttachment || part is TnefPart)) {
                var value = ReadEntity(part, depth + 1, ref visited);
                if (!string.IsNullOrWhiteSpace(value)) return value;
            }
        }
        return null;
    }

    static string PlainHtml(string html) {
        using var reader = new StringReader(html);
        var tokenizer = new HtmlTokenizer(reader) { DecodeCharacterReferences = true };
        var text = new StringBuilder();
        var ignored = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "script", "style", "head" };
        var blocks = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "p", "div", "br", "li", "tr", "h1", "h2", "h3" };
        var skip = 0;
        while (tokenizer.ReadNextToken(out var token)) {
            if (token is HtmlTagToken tag) {
                if (ignored.Contains(tag.Name)) skip = Math.Max(0, skip + (tag.IsEndTag ? -1 : 1));
                if (skip == 0 && blocks.Contains(tag.Name)) text.AppendLine();
            } else if (skip == 0 && token is HtmlDataToken data) {
                text.Append(data.Data);
            }
            if (text.Length > 2 * 1024 * 1024) throw new EwsFailure("response_limit");
        }
        return text.ToString();
    }
}
