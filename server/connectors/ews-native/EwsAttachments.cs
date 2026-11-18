using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace AnotherRae.Ews;

public sealed partial class EwsClient {
    static bool OpaqueSmime(XElement item) => string.Equals((string?)item.Element(Types + "ItemClass"), "IPM.Note.SMIME", StringComparison.OrdinalIgnoreCase);
    static string Revision(XElement item) => Attribute(item.Element(Types + "ItemId"), "ChangeKey");
    static bool Protected(string encryption) => encryption is "smime" or "smime-decrypted";
    static string SafeContentType(XElement item) {
        var value = (string?)item.Element(Types + "ContentType") ?? "application/octet-stream";
        return value.Length <= 200 && !value.Any(char.IsControl) ? value : "application/octet-stream";
    }
    static bool Inline(XElement item) => (string?)item.Element(Types + "IsInline") == "true";
    static string Digest(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));

    async Task<XElement> GetMessage(string id, IEnumerable<XElement> properties, CancellationToken signal, bool body = false) {
        if (!ValidId(id)) throw new EwsFailure("invalid_input");
        var result = await Call("GetItem", new XElement(Messages + "GetItem",
            new XElement(Messages + "ItemShape", new XElement(Types + "BaseShape", "IdOnly"),
                body ? new XElement(Types + "BodyType", "Text") : null,
                new XElement(Types + "AdditionalProperties", Field("item:ParentFolderId"), properties)),
            new XElement(Messages + "ItemIds", new XElement(Types + "ItemId", new XAttribute("Id", id)))), signal);
        var items = result.Element(Messages + "Items")?.Elements().ToArray();
        if (items is null || items.Length != 1 || items[0].Name != Types + "Message"
            || Attribute(items[0].Element(Types + "ItemId"), "Id") != id) throw new EwsFailure("invalid_response");
        return items[0];
    }

    async Task<XElement> InboxMetadata(string folderId, string messageId, CancellationToken signal, bool attachments = false) {
        await CheckInbox(folderId, signal);
        var item = await GetMessage(messageId, attachments ? [Field("item:ItemClass"), Field("item:Attachments")] : [], signal);
        if (Attribute(item.Element(Types + "ParentFolderId"), "Id") != folderId) throw new EwsFailure("scope");
        return item;
    }

    async Task CheckSelected(string folderId, string messageId, string revision, CancellationToken signal) {
        var item = await GetMessage(messageId, [], signal);
        if (Attribute(item.Element(Types + "ParentFolderId"), "Id") != folderId) throw new EwsFailure("scope");
        if (Revision(item) != revision) throw new EwsFailure("revision");
    }

    async Task<byte[]> DownloadFile(string messageId, string attachmentId, int maximum, CancellationToken signal) {
        var response = await Call("GetAttachment", new XElement(Messages + "GetAttachment",
            new XElement(Messages + "AttachmentIds", new XElement(Types + "AttachmentId", new XAttribute("Id", attachmentId)))), signal);
        var files = response.Element(Messages + "Attachments")?.Elements().ToArray();
        if (files is null || files.Length != 1 || files[0].Name != Types + "FileAttachment"
            || Attribute(files[0].Element(Types + "AttachmentId"), "Id") != attachmentId) throw new EwsFailure("invalid_response");
        var root = (string?)files[0].Element(Types + "AttachmentId")?.Attribute("RootItemId");
        if (root is not null && root != messageId) throw new EwsFailure("invalid_response");
        // Content may be empty for an empty file; no file-system extraction is used.
        var encoded = (string?)files[0].Element(Types + "Content") ?? throw new EwsFailure("invalid_response");
        if (encoded.Length > 4L * ((maximum + 2L) / 3L) + 1024) throw new EwsFailure("response_limit");
        byte[] bytes;
        try { bytes = Convert.FromBase64String(encoded); } catch (FormatException) { throw new EwsFailure("invalid_response"); }
        if (bytes.Length > maximum) { CryptographicOperations.ZeroMemory(bytes); throw new EwsFailure("response_limit"); }
        return bytes;
    }

    sealed class SmimePayload(byte[] content, string encryption, string containerId, string hash) : IDisposable {
        public byte[] Content { get; } = content;
        public string Encryption { get; } = encryption;
        public string ContainerId { get; } = containerId;
        public string Hash { get; } = hash;
        public void Dispose() => CryptographicOperations.ZeroMemory(Content);
    }

    async Task<SmimePayload> LoadSmimePayload(string messageId, XElement item, CancellationToken signal) {
        var containers = item.Element(Types + "Attachments")?.Elements(Types + "FileAttachment").Where(attachment =>
            Regex.IsMatch((string?)attachment.Element(Types + "ContentType") ?? "", "^application/(?:x-)?pkcs7-mime$", RegexOptions.IgnoreCase)).ToArray();
        if (containers is null || containers.Length != 1) throw new EwsFailure("smime_container");
        if (Count(containers[0], Types + "Size") > MailContent.MaximumMimeBytes) throw new EwsFailure("response_limit");
        var id = Attribute(containers[0].Element(Types + "AttachmentId"), "Id");
        var bytes = await DownloadFile(messageId, id, MailContent.MaximumMimeBytes, signal);
        try {
            var hash = Digest(bytes);
            var (plain, encryption) = MailContent.Unprotect(bytes, certificates);
            if (plain.Length > MailContent.MaximumMimeBytes) { CryptographicOperations.ZeroMemory(plain); throw new EwsFailure("response_limit"); }
            return new SmimePayload(plain, encryption, id, hash);
        } finally { CryptographicOperations.ZeroMemory(bytes); }
    }

    static string MailboxAddress(XElement? mailbox) {
        var address = (string?)mailbox?.Element(Types + "EmailAddress") ?? "";
        return address.Length <= 400 && !address.Any(char.IsControl) ? address : throw new EwsFailure("invalid_response");
    }
    static string[] Addresses(XElement item, string field) {
        var values = item.Element(Types + field)?.Elements(Types + "Mailbox").Select(MailboxAddress).Where(value => value.Length != 0).ToArray() ?? [];
        if (values.Length > 500) throw new EwsFailure("response_limit");
        return values;
    }
    static string? ReceivingAddress(XElement item) {
        var selected = new[] { "ReceivedBy", "ReceivedRepresenting" }.Select(field => item.Element(Types + field)?.Element(Types + "Mailbox"))
            .Where(mailbox => mailbox is not null && string.Equals((string?)mailbox.Element(Types + "RoutingType"), "SMTP", StringComparison.OrdinalIgnoreCase))
            .Select(MailboxAddress).Where(address => ValidSmtp(address)).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        return selected.Length == 1 ? selected[0] : null;
    }

    public async Task<NativeMessageInfo> MessageInfo(MailInfoRequest request, CancellationToken signal) {
        var read = await ReadSelected(new MailRead(request.FolderId, request.MessageId), signal) ?? throw new EwsFailure("scope");
        var item = await GetMessage(request.MessageId, [Field("item:Subject"), Field("message:From"), Field("message:ToRecipients"),
            Field("message:CcRecipients"), Field("message:BccRecipients"), Field("message:ReplyTo"), Field("message:InternetMessageId"),
            Field("message:ReceivedBy"), Field("message:ReceivedRepresenting")], signal);
        if (Attribute(item.Element(Types + "ParentFolderId"), "Id") != request.FolderId) throw new EwsFailure("scope");
        if (Revision(item) != read.Revision) throw new EwsFailure("revision");
        var subject = (string?)item.Element(Types + "Subject") ?? "";
        var internetId = (string?)item.Element(Types + "InternetMessageId") ?? "";
        if (subject.Length > 998 || internetId.Length > 4096) throw new EwsFailure("response_limit");
        return new NativeMessageInfo(request.MessageId, read.Revision, subject, MailboxAddress(item.Element(Types + "From")?.Element(Types + "Mailbox")),
            Addresses(item, "ToRecipients"), Addresses(item, "CcRecipients"), Addresses(item, "BccRecipients"), Addresses(item, "ReplyTo"),
            ReceivingAddress(item), internetId, read.Encryption, read.BodyStatus, read.Body, read.TotalCharacters, read.Truncated);
    }

    static NativeAttachment OrdinaryAttachment(XElement attachment, bool sourceProtected) {
        var id = Attribute(attachment.Element(Types + "AttachmentId"), "Id");
        var file = attachment.Name == Types + "FileAttachment";
        var size = Count(attachment, Types + "Size");
        return new NativeAttachment("ews:" + Convert.ToBase64String(Encoding.UTF8.GetBytes(id)), MailContent.AttachmentName((string?)attachment.Element(Types + "Name")),
            SafeContentType(attachment), size, Inline(attachment), file ? "file" : "item", file && size <= MaximumAttachmentBytes,
            sourceProtected, !file ? "item_attachment" : size > MaximumAttachmentBytes ? "size_limit" : null);
    }

    public async Task<NativeAttachmentPage> ListAttachments(MailAttachmentListRequest request, CancellationToken signal) {
        var item = await InboxMetadata(request.FolderId, request.MessageId, signal, true);
        var revision = Revision(item); var sourceProtected = false;
        var output = new List<NativeAttachment>();
        string? containerId = null;
        if (OpaqueSmime(item)) {
            using var content = await LoadSmimePayload(request.MessageId, item, signal);
            containerId = content.ContainerId; sourceProtected = Protected(content.Encryption);
            foreach (var file in MailContent.ListAttachments(content.Content)) output.Add(new NativeAttachment(
                "mime:" + content.Hash + ":" + file.Path, file.Name, file.ContentType, file.Size, file.IsInline, file.Kind,
                file.Supported, sourceProtected, file.Kind == "item" ? "item_attachment" : !file.Supported ? "size_limit" : null));
        }
        foreach (var attachment in item.Element(Types + "Attachments")?.Elements() ?? []) {
            if (Attribute(attachment.Element(Types + "AttachmentId"), "Id") == containerId) continue;
            output.Add(OrdinaryAttachment(attachment, false));
        }
        if (output.Count > 100) throw new EwsFailure("response_limit");
        await CheckSelected(request.FolderId, request.MessageId, revision, signal);
        return new NativeAttachmentPage(request.MessageId, revision, sourceProtected, output.ToArray());
    }

    public async Task<NativeAttachmentBytes> ReadAttachment(MailAttachmentReadRequest request, CancellationToken signal) {
        if (!ValidId(request.Revision) || request.Reference is null || request.Reference.Length > 16000) throw new EwsFailure("invalid_input");
        var item = await InboxMetadata(request.FolderId, request.MessageId, signal, true);
        if (Revision(item) != request.Revision) throw new EwsFailure("revision");
        byte[] bytes; string name; string contentType; bool inline; var sourceProtected = false;
        if (request.Reference.StartsWith("mime:", StringComparison.Ordinal) && OpaqueSmime(item)) {
            var parts = request.Reference.Split(':', 3);
            if (parts.Length != 3 || !Regex.IsMatch(parts[1], "^[a-f0-9]{64}$")) throw new EwsFailure("invalid_attachment");
            using var content = await LoadSmimePayload(request.MessageId, item, signal);
            if (content.Hash != parts[1]) throw new EwsFailure("revision");
            var selected = MailContent.ReadAttachment(content.Content, parts[2]);
            bytes = selected.Content; name = selected.Name; contentType = selected.ContentType; inline = selected.IsInline;
            sourceProtected = Protected(content.Encryption);
        } else if (request.Reference.StartsWith("ews:", StringComparison.Ordinal)) {
            string id;
            try { id = new UTF8Encoding(false, true).GetString(Convert.FromBase64String(request.Reference[4..])); }
            catch { throw new EwsFailure("invalid_attachment"); }
            if (!ValidId(id)) throw new EwsFailure("invalid_attachment");
            var metadata = item.Element(Types + "Attachments")?.Elements().Where(attachment =>
                (string?)attachment.Element(Types + "AttachmentId")?.Attribute("Id") == id).ToArray();
            if (metadata is null || metadata.Length != 1) throw new EwsFailure("attachment_not_found");
            var descriptor = OrdinaryAttachment(metadata[0], false);
            if (!descriptor.Supported || OpaqueSmime(item) && Regex.IsMatch(descriptor.ContentType, "^application/(?:x-)?pkcs7-mime$", RegexOptions.IgnoreCase)) throw new EwsFailure("unsupported_attachment");
            bytes = await DownloadFile(request.MessageId, id, MaximumAttachmentBytes, signal);
            if (bytes.Length != descriptor.Size) { CryptographicOperations.ZeroMemory(bytes); throw new EwsFailure("invalid_response"); }
            name = descriptor.Name; contentType = descriptor.ContentType; inline = descriptor.IsInline;
        } else throw new EwsFailure("invalid_attachment");
        try {
            await CheckSelected(request.FolderId, request.MessageId, request.Revision, signal);
            return new NativeAttachmentBytes(name, contentType, bytes.Length, Digest(bytes), Convert.ToBase64String(bytes), inline, sourceProtected);
        } finally { CryptographicOperations.ZeroMemory(bytes); }
    }
}
