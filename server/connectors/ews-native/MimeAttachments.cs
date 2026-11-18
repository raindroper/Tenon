using System.Security.Cryptography.Pkcs;
using System.Security.Cryptography;
using MimeKit;
using MimeKit.Cryptography;
using MimeKit.Tnef;

namespace AnotherRae.Ews;

public sealed record MimeAttachmentDescription(string Path, string Name, string ContentType, long Size, bool IsInline, string Kind, bool Supported);
public sealed record MimeAttachmentContent(string Name, string ContentType, byte[] Content, bool IsInline);

public static partial class MailContent {
    public static string AttachmentName(string? value) {
        var name = (value ?? "attachment").Replace('\\', '/').Split('/').Last();
        name = new string(name.Where(character => !char.IsControl(character)).ToArray()).Trim();
        if (name.Length == 0 || name is "." or "..") name = "attachment";
        return name[..Math.Min(name.Length, 200)];
    }

    static bool AttachmentEntity(MimeEntity entity) => entity.IsAttachment || entity is MessagePart
        || entity is MimePart part && (!string.IsNullOrEmpty(part.FileName)
            || !string.IsNullOrEmpty(part.ContentId) && entity is not TextPart);

    public static MimeAttachmentDescription[] ListAttachments(byte[] bytes) {
        var descriptions = new List<MimeAttachmentDescription>(); var visited = 0;
        WalkBytes(bytes, "r", 0, ref visited, (entity, path) => {
            if (!AttachmentEntity(entity)) return;
            if (descriptions.Count >= 100) throw new EwsFailure("response_limit");
            var contentType = entity.ContentType.MimeType;
            var name = AttachmentName(entity is MimePart part ? part.FileName : entity.ContentDisposition?.FileName);
            using var counter = new BoundedWriteStream(MaximumMimeBytes);
            var supported = entity is MimePart { Content: not null };
            if (entity is MimePart file && file.Content is not null) file.Content.DecodeTo(counter);
            else entity.WriteTo(counter);
            descriptions.Add(new MimeAttachmentDescription(path, name, contentType, counter.Length,
                !entity.IsAttachment, supported ? "file" : "item", supported && counter.Length <= EwsClient.MaximumAttachmentBytes));
        });
        return descriptions.ToArray();
    }

    public static MimeAttachmentContent ReadAttachment(byte[] bytes, string selectedPath) {
        if (selectedPath.Length > 200 || !System.Text.RegularExpressions.Regex.IsMatch(selectedPath, @"^r(?:/(?:[0-9]{1,3}|s|t)){0,16}$")) throw new EwsFailure("invalid_attachment");
        MimeAttachmentContent? output = null; var visited = 0;
        WalkBytes(bytes, "r", 0, ref visited, (entity, path) => {
            if (path != selectedPath) return;
            if (output is not null || !AttachmentEntity(entity) || entity is not MimePart { Content: not null } part) throw new EwsFailure("unsupported_attachment");
            using var memory = new MemoryStream(); using var bounded = new BoundedWriteStream(EwsClient.MaximumAttachmentBytes, memory);
            part.Content.DecodeTo(bounded);
            output = new MimeAttachmentContent(AttachmentName(part.FileName), part.ContentType.MimeType, memory.ToArray(), !part.IsAttachment);
        });
        return output ?? throw new EwsFailure("attachment_not_found");
    }

    static void WalkBytes(byte[] bytes, string path, int depth, ref int visited, Action<MimeEntity, string> inspect) {
        if (bytes.Length > MaximumMimeBytes || depth > 8) throw new EwsFailure("response_limit");
        if (bytes.Length > 0 && bytes[0] == 0x30) {
            try {
                var signed = new SignedCms(); signed.Decode(bytes);
                WalkBytes(signed.ContentInfo.Content, path + "/s", depth + 1, ref visited, inspect); return;
            } catch (CryptographicException) { }
        }
        using var stream = new MemoryStream(bytes, writable: false);
        using var entity = bytes.Length > 4 && bytes.AsSpan(0, 4).SequenceEqual(new byte[] { 0x78, 0x9f, 0x3e, 0x22 })
            ? MimeEntity.Load(new ContentType("application", "ms-tnef"), stream) : MimeEntity.Load(stream);
        WalkEntity(entity, path, depth, ref visited, inspect);
    }

    static void WalkEntity(MimeEntity entity, string path, int depth, ref int visited, Action<MimeEntity, string> inspect) {
        if (depth > 8 || ++visited > 256) throw new EwsFailure("response_limit");
        if (entity is ApplicationPkcs7Mime pkcs7) {
            if (pkcs7.SecureMimeType != SecureMimeType.SignedData) throw new EwsFailure("mime");
            using var buffer = new MemoryStream(); using var bounded = new BoundedWriteStream(MaximumMimeBytes, buffer);
            (pkcs7.Content ?? throw new EwsFailure("mime")).DecodeTo(bounded);
            var signed = new SignedCms(); signed.Decode(buffer.ToArray());
            WalkBytes(signed.ContentInfo.Content, path + "/s", depth + 1, ref visited, inspect); return;
        }
        if (entity is TnefPart tnef) {
            using var converted = tnef.ConvertToMessage();
            WalkEntity(converted.Body ?? throw new EwsFailure("mime"), path + "/t", depth + 1, ref visited, inspect); return;
        }
        if (entity is Multipart multipart && !entity.IsAttachment) {
            for (var index = 0; index < multipart.Count; index++) WalkEntity(multipart[index], path + "/" + index, depth + 1, ref visited, inspect);
            return;
        }
        inspect(entity, path);
    }
}

public sealed class BoundedWriteStream(long maximum, Stream? target = null) : Stream {
    long length;
    public override bool CanRead => false;
    public override bool CanSeek => false;
    public override bool CanWrite => true;
    public override long Length => length;
    public override long Position { get => length; set => throw new NotSupportedException(); }
    public override void Flush() => target?.Flush();
    public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) {
        if (count < 0 || length + count > maximum) throw new EwsFailure("response_limit");
        target?.Write(buffer, offset, count); length += count;
    }
    public override void Write(ReadOnlySpan<byte> buffer) {
        if (length + buffer.Length > maximum) throw new EwsFailure("response_limit");
        target?.Write(buffer); length += buffer.Length;
    }
}
