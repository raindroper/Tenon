using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;
using MimeKit;

namespace AnotherRae.Ews;

public sealed partial class EwsClient {
    const string MarkerSet = "6b08a5e5-c6cf-4a1b-918e-a64b97ba6a7e";
    const string MarkerName = "AnotherRaeOperationId";
    static XElement MarkerField() => new(Types + "ExtendedFieldURI", new XAttribute("PropertySetId", MarkerSet),
        new XAttribute("PropertyName", MarkerName), new XAttribute("PropertyType", "String"));
    static XElement Marker(string operationId) => new(Types + "ExtendedProperty", MarkerField(), new XElement(Types + "Value", operationId));
    static bool ValidOperation(string? value) => value is not null && Regex.IsMatch(value, "^[A-Za-z0-9_-]{1,200}$");
    static bool ValidSmtp(string? value) => value is not null && value.Length is >= 3 and <= 320 && !value.Any(char.IsControl)
        && !value.Any(char.IsWhiteSpace) && MimeKit.MailboxAddress.TryParse(value, out var mailbox)
        && mailbox is not null && mailbox.Address == value && mailbox.Address.Contains('@') && string.IsNullOrEmpty(mailbox.Name);
    static bool XmlText(string? value, int maximum, bool multiline = false) {
        if (value is null || value.Length > maximum || value.Any(character => char.IsControl(character) && (!multiline || character is not '\r' and not '\n' and not '\t'))) return false;
        try { XmlConvert.VerifyXmlChars(value); return true; } catch (XmlException) { return false; }
    }
    static void ValidateRecipients(NativeRecipient[]? to, NativeRecipient[]? cc, NativeRecipient[]? bcc) {
        if (to is null || cc is null || bcc is null) throw new EwsFailure("invalid_input");
        var recipients = to.Concat(cc).Concat(bcc).ToArray();
        if (recipients.Length is < 1 or > 50 || recipients.Any(recipient => recipient is null || !ValidSmtp(recipient.Address)
            || recipient.Name is not null && !XmlText(recipient.Name, 200))) throw new EwsFailure("invalid_input");
    }
    static XElement RecipientField(string field, IEnumerable<NativeRecipient> recipients) => new(Types + field,
        recipients.Select(recipient => new XElement(Types + "Mailbox", recipient.Name is null ? null : new XElement(Types + "Name", recipient.Name),
            new XElement(Types + "EmailAddress", recipient.Address), new XElement(Types + "RoutingType", "SMTP"))));
    static NativeRecipient[] RecipientValues(XElement item, string field) {
        var mailboxes = item.Element(Types + field)?.Elements(Types + "Mailbox").ToArray() ?? [];
        if (mailboxes.Length > 50) throw new EwsFailure("response_limit");
        return mailboxes.Select(mailbox => {
            var address = MailboxAddress(mailbox);
            var name = (string?)mailbox.Element(Types + "Name");
            if (!ValidSmtp(address) || name is not null && !XmlText(name, 200)) throw new EwsFailure("invalid_response");
            return new NativeRecipient(address, name);
        }).ToArray();
    }

    async Task<string> OwnFolder(string name, CancellationToken signal) {
        if (name is not "drafts" and not "sentitems") throw new EwsFailure("invalid_input");
        var response = await Call("GetFolder", new XElement(Messages + "GetFolder",
            new XElement(Messages + "FolderShape", new XElement(Types + "BaseShape", "IdOnly")),
            new XElement(Messages + "FolderIds", new XElement(Types + "DistinguishedFolderId", new XAttribute("Id", name)))), signal);
        var folders = response.Element(Messages + "Folders")?.Elements().ToArray();
        if (folders is null || folders.Length != 1) throw new EwsFailure("invalid_response");
        return Attribute(folders[0].Element(Types + "FolderId"), "Id");
    }

    static void CheckMarker(XElement draft, string operationId) {
        var markers = draft.Elements(Types + "ExtendedProperty").Where(property => {
            var field = property.Element(Types + "ExtendedFieldURI");
            return string.Equals((string?)field?.Attribute("PropertySetId"), MarkerSet, StringComparison.OrdinalIgnoreCase)
                && (string?)field?.Attribute("PropertyName") == MarkerName && (string?)field?.Attribute("PropertyType") == "String";
        }).ToArray();
        if (markers.Length != 1 || (string?)markers[0].Element(Types + "Value") != operationId) throw new EwsFailure("draft_scope");
    }

    async Task<XElement> Draft(string draftId, string draftsFolder, string? operationId, CancellationToken signal, bool content = false) {
        var item = await GetMessage(draftId, [Field("item:IsDraft"), Field("item:ItemClass"), Field("item:Attachments"), MarkerField()], signal);
        if (Attribute(item.Element(Types + "ParentFolderId"), "Id") != draftsFolder || !Boolean(item, Types + "IsDraft")) throw new EwsFailure("draft_scope");
        if (operationId is not null) CheckMarker(item, operationId);
        if (content) {
            var revision = Revision(item);
            item = await GetMessage(draftId, [Field("item:IsDraft"), Field("item:ItemClass"), Field("item:Subject"), Field("item:Body"),
                Field("item:Attachments"), Field("message:ToRecipients"), Field("message:CcRecipients"), Field("message:BccRecipients"), MarkerField()], signal, true);
            if (Attribute(item.Element(Types + "ParentFolderId"), "Id") != draftsFolder || !Boolean(item, Types + "IsDraft")) throw new EwsFailure("draft_scope");
            if (operationId is not null) CheckMarker(item, operationId);
            if (Revision(item) != revision) throw new EwsFailure("revision");
        }
        return item;
    }

    static (string Id, string Revision) ReturnedItem(XElement response, string? expectedId = null) {
        var items = response.Element(Messages + "Items")?.Elements().ToArray();
        if (items is null || items.Length != 1 || items[0].Name != Types + "Message") throw new EwsFailure("invalid_response");
        var id = Attribute(items[0].Element(Types + "ItemId"), "Id");
        if (expectedId is not null && expectedId != id) throw new EwsFailure("invalid_response");
        return (id, Revision(items[0]));
    }

    async Task<string> UpdateDraft(string draftId, string revision, IEnumerable<XElement> updates, CancellationToken signal) {
        var response = await Call("UpdateItem", new XElement(Messages + "UpdateItem", new XAttribute("ConflictResolution", "NeverOverwrite"),
            new XAttribute("MessageDisposition", "SaveOnly"),
            new XElement(Messages + "ItemChanges", new XElement(Types + "ItemChange",
                new XElement(Types + "ItemId", new XAttribute("Id", draftId), new XAttribute("ChangeKey", revision)),
                new XElement(Types + "Updates", updates)))), signal, true);
        return ReturnedItem(response, draftId).Revision;
    }
    static XElement SetField(string field, XElement value) => new(Types + "SetItemField", Field(field), new XElement(Types + "Message", value));
    static XElement SetRecipients(string field, string property, NativeRecipient[] recipients) => recipients.Length == 0
        ? new XElement(Types + "DeleteItemField", Field(field)) : SetField(field, RecipientField(property, recipients));

    public async Task<NativeDraftSnapshot> PrepareMessage(PrepareMessageRequest request, CancellationToken signal) {
        if (!ValidOperation(request.OperationId) || request.Mode is not "send" and not "reply" and not "replyAll" and not "forward"
            || !XmlText(request.Subject, 998) || !XmlText(request.Body, 200_000, true)
            || (request.Mode == "send") != (request.Source is null)) throw new EwsFailure("invalid_input");
        ValidateRecipients(request.To, request.Cc, request.Bcc);
        if (request.Source is { } source) {
            if (!ValidId(source.Revision)) throw new EwsFailure("invalid_input");
            var original = await InboxMetadata(source.FolderId, source.MessageId, signal, true);
            if (Revision(original) != source.Revision) throw new EwsFailure("revision");
            if (OpaqueSmime(original) && !request.AllowPlaintextProtectedSource) {
                try { using var content = await LoadSmimePayload(source.MessageId, original, signal); if (Protected(content.Encryption)) throw new EwsFailure("protected_source"); }
                catch (EwsFailure error) when (error.Code is "certificate_missing" or "decrypt") { throw new EwsFailure("protected_source"); }
            }
        }
        var draftsFolder = await OwnFolder("drafts", signal);
        var message = new XElement(Types + (request.Mode switch { "reply" => "ReplyToItem", "replyAll" => "ReplyAllToItem", "forward" => "ForwardItem", _ => "Message" }),
            new XElement(Types + "Subject", request.Subject));
        if (request.Mode == "send") {
            message.Add(new XElement(Types + "Body", new XAttribute("BodyType", "Text"), request.Body), Marker(request.OperationId));
        }
        if (request.To.Length > 0) message.Add(RecipientField("ToRecipients", request.To));
        if (request.Cc.Length > 0) message.Add(RecipientField("CcRecipients", request.Cc));
        if (request.Bcc.Length > 0) message.Add(RecipientField("BccRecipients", request.Bcc));
        if (request.Source is { } reference) message.Add(new XElement(Types + "ReferenceItemId", new XAttribute("Id", reference.MessageId),
            new XAttribute("ChangeKey", reference.Revision)), new XElement(Types + "NewBodyContent", new XAttribute("BodyType", "Text"), request.Body));
        var created = await Call("CreateItem", new XElement(Messages + "CreateItem", new XAttribute("MessageDisposition", "SaveOnly"),
            new XElement(Messages + "SavedItemFolderId", new XElement(Types + "FolderId", new XAttribute("Id", draftsFolder))),
            new XElement(Messages + "Items", message)), signal, true);
        var (draftId, revision) = ReturnedItem(created); mutationDraftId = draftId;
        var draft = await Draft(draftId, draftsFolder, request.Mode == "send" ? request.OperationId : null, signal);
        if (Revision(draft) != revision) throw new EwsFailure("revision");
        // Smart-response creation preserves threading, but Exchange may add hidden original
        // body/recipients/attachments. Replace the final authored text and recipient set.
        revision = await UpdateDraft(draftId, revision, [
            new XElement(Types + "SetItemField", MarkerField(), new XElement(Types + "Message", Marker(request.OperationId))),
            SetField("item:ItemClass", new XElement(Types + "ItemClass", "IPM.Note")),
            SetField("item:Subject", new XElement(Types + "Subject", request.Subject)),
            SetField("item:Body", new XElement(Types + "Body", new XAttribute("BodyType", "Text"), request.Body)),
            SetRecipients("message:ToRecipients", "ToRecipients", request.To), SetRecipients("message:CcRecipients", "CcRecipients", request.Cc),
            SetRecipients("message:BccRecipients", "BccRecipients", request.Bcc)], signal);
        // Only this newly created, marked Drafts item can have inherited attachments removed.
        // The original received message is never an attachment-mutation target.
        draft = await Draft(draftId, draftsFolder, request.OperationId, signal);
        if (Revision(draft) != revision) throw new EwsFailure("revision");
        var inherited = draft.Element(Types + "Attachments")?.Elements().ToArray() ?? [];
        if (inherited.Length > 100) throw new EwsFailure("response_limit");
        foreach (var attachment in inherited) {
            var current = await Draft(draftId, draftsFolder, request.OperationId, signal);
            if (Revision(current) != revision) throw new EwsFailure("revision");
            var attachmentId = Attribute(attachment.Element(Types + "AttachmentId"), "Id");
            if (!current.Element(Types + "Attachments")!.Elements().Any(value => (string?)value.Element(Types + "AttachmentId")?.Attribute("Id") == attachmentId)) throw new EwsFailure("revision");
            var removed = await Call("DeleteAttachment", new XElement(Messages + "DeleteAttachment",
                new XElement(Messages + "AttachmentIds", new XElement(Types + "AttachmentId", new XAttribute("Id", attachmentId)))), signal, true);
            var root = removed.Element(Messages + "RootItemId");
            if (Attribute(root, "RootItemId") != draftId) throw new EwsFailure("invalid_response");
            revision = Attribute(root, "RootItemChangeKey");
        }
        var result = await InspectDraft(new InspectDraftRequest(request.OperationId, draftId), signal);
        if (result.Revision != revision || result.Attachments.Length != 0
            || result.Subject != request.Subject || NormalizeBody(result.Body) != NormalizeBody(request.Body)
            || !SameRecipients(result.To, request.To) || !SameRecipients(result.Cc, request.Cc) || !SameRecipients(result.Bcc, request.Bcc)) throw new EwsFailure("snapshot");
        return result;
    }
    static string NormalizeBody(string value) => value.Replace("\r\n", "\n");
    static bool SameRecipients(NativeRecipient[] actual, NativeRecipient[] expected) => actual.Select(value => value.Address.ToLowerInvariant()).Order()
        .SequenceEqual(expected.Select(value => value.Address.ToLowerInvariant()).Order());

    static byte[] CustodyFile(AttachFileRequest request) {
        var file = request.File;
        if (file is null || file.Size < 0 || file.Size > MaximumAttachmentBytes || !Regex.IsMatch(file.Sha256 ?? "", "^[a-f0-9]{64}$")
            || !XmlText(file.Name, 200) || file.Name.Length == 0 || file.Name != MailContent.AttachmentName(file.Name)
            || !XmlText(file.ContentType, 200) || !Regex.IsMatch(file.ContentType, "^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$")) throw new EwsFailure("invalid_file");
        try {
            if (!Path.IsPathFullyQualified(request.CustodyRoot) || !Path.IsPathFullyQualified(file.Path)) throw new EwsFailure("invalid_file");
            var root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(request.CustodyRoot));
            var path = Path.GetFullPath(file.Path);
            var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
            if (!path.StartsWith(root + Path.DirectorySeparatorChar, comparison)) throw new EwsFailure("invalid_file");
            void CheckLinks() {
                for (var current = path; current is not null; current = Path.GetDirectoryName(current)) {
                    if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new EwsFailure("invalid_file");
                    if (Path.GetDirectoryName(current) == current) break;
                }
            }
            CheckLinks();
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.None);
            if (stream.Length != file.Size) throw new EwsFailure("invalid_file");
            var bytes = new byte[checked((int)file.Size)]; stream.ReadExactly(bytes);
            if (stream.ReadByte() != -1 || Digest(bytes) != file.Sha256) { CryptographicOperations.ZeroMemory(bytes); throw new EwsFailure("invalid_file"); }
            try { CheckLinks(); return bytes; } catch { CryptographicOperations.ZeroMemory(bytes); throw; }
        } catch (EwsFailure) { throw; }
        catch { throw new EwsFailure("invalid_file"); }
    }

    public async Task<NativeDraftSnapshot> AttachFile(AttachFileRequest request, CancellationToken signal) {
        if (!ValidOperation(request.OperationId) || !ValidId(request.DraftId) || !ValidId(request.Revision)) throw new EwsFailure("invalid_input");
        var snapshot = await InspectDraft(new InspectDraftRequest(request.OperationId, request.DraftId), signal);
        if (snapshot.Revision != request.Revision) throw new EwsFailure("revision");
        if (snapshot.Attachments.Length >= 10 || request.File is null || snapshot.Attachments.Sum(file => file.Size) + request.File.Size > MaximumOutgoingAttachmentBytes) throw new EwsFailure("file_limit");
        var bytes = CustodyFile(request);
        try {
            // Recheck the exact app-created Drafts item immediately before attachment mutation.
            var drafts = await OwnFolder("drafts", signal);
            var draft = await Draft(request.DraftId, drafts, request.OperationId, signal);
            if (Revision(draft) != request.Revision) throw new EwsFailure("revision");
            mutationDraftId = request.DraftId;
            var response = await Call("CreateAttachment", new XElement(Messages + "CreateAttachment",
                new XElement(Messages + "ParentItemId", new XAttribute("Id", request.DraftId), new XAttribute("ChangeKey", request.Revision)),
                new XElement(Messages + "Attachments", new XElement(Types + "FileAttachment", new XElement(Types + "Name", request.File.Name),
                    new XElement(Types + "ContentType", request.File.ContentType), new XElement(Types + "IsInline", false),
                    new XElement(Types + "Content", Convert.ToBase64String(bytes))))), signal, true);
            var files = response.Element(Messages + "Attachments")?.Elements(Types + "FileAttachment").ToArray();
            if (files is null || files.Length != 1 || Attribute(files[0].Element(Types + "AttachmentId"), "RootItemId") != request.DraftId) throw new EwsFailure("invalid_response");
            var newRevision = Attribute(files[0].Element(Types + "AttachmentId"), "RootItemChangeKey");
            var result = await InspectDraft(new InspectDraftRequest(request.OperationId, request.DraftId), signal);
            if (result.Revision != newRevision || result.Attachments.Length != snapshot.Attachments.Length + 1) throw new EwsFailure("snapshot");
            return result;
        } finally { CryptographicOperations.ZeroMemory(bytes); }
    }

    public async Task<NativeDraftSnapshot> InspectDraft(InspectDraftRequest request, CancellationToken signal) {
        if (!ValidOperation(request.OperationId) || !ValidId(request.DraftId)) throw new EwsFailure("invalid_input");
        var drafts = await OwnFolder("drafts", signal);
        var draft = await Draft(request.DraftId, drafts, request.OperationId, signal, true);
        if ((string?)draft.Element(Types + "ItemClass") != "IPM.Note") throw new EwsFailure("draft_scope");
        var revision = Revision(draft);
        var subject = (string?)draft.Element(Types + "Subject") ?? "";
        var body = (string?)draft.Element(Types + "Body") ?? "";
        if (!XmlText(subject, 998) || !XmlText(body, 200_000, true)) throw new EwsFailure("response_limit");
        var to = RecipientValues(draft, "ToRecipients"); var cc = RecipientValues(draft, "CcRecipients"); var bcc = RecipientValues(draft, "BccRecipients");
        ValidateRecipients(to, cc, bcc);
        var metadata = draft.Element(Types + "Attachments")?.Elements().ToArray() ?? [];
        if (metadata.Length > 10) throw new EwsFailure("file_limit");
        var attachments = new List<NativeDraftAttachment>(); long total = 0;
        foreach (var file in metadata) {
            if (file.Name != Types + "FileAttachment" || Inline(file)) throw new EwsFailure("unsupported_attachment");
            var descriptor = OrdinaryAttachment(file, false);
            if ((string?)file.Element(Types + "Name") != descriptor.Name) throw new EwsFailure("snapshot");
            if (!descriptor.Supported || (total += descriptor.Size) > MaximumOutgoingAttachmentBytes) throw new EwsFailure("file_limit");
            var id = Attribute(file.Element(Types + "AttachmentId"), "Id");
            var bytes = await DownloadFile(request.DraftId, id, MaximumAttachmentBytes, signal);
            try {
                if (bytes.Length != descriptor.Size) throw new EwsFailure("invalid_response");
                attachments.Add(new NativeDraftAttachment(id, descriptor.Name, descriptor.ContentType, bytes.Length, Digest(bytes)));
            } finally { CryptographicOperations.ZeroMemory(bytes); }
        }
        var current = await Draft(request.DraftId, drafts, request.OperationId, signal);
        if (Revision(current) != revision) throw new EwsFailure("revision");
        var result = new NativeDraftSnapshot(request.OperationId, request.DraftId, revision, to, cc, bcc, subject, body, attachments.ToArray(), "");
        var hash = Digest(JsonSerializer.SerializeToUtf8Bytes(result));
        return result with { SnapshotHash = hash };
    }

    public async Task<NativeSubmitResult> SubmitDraft(SubmitDraftRequest request, CancellationToken signal) {
        if (!ValidOperation(request.OperationId) || !ValidId(request.DraftId) || !ValidId(request.Revision)
            || !Regex.IsMatch(request.SnapshotHash ?? "", "^[a-f0-9]{64}$")) throw new EwsFailure("invalid_input");
        var snapshot = await InspectDraft(new InspectDraftRequest(request.OperationId, request.DraftId), signal);
        if (snapshot.Revision != request.Revision || snapshot.SnapshotHash != request.SnapshotHash) throw new EwsFailure("snapshot");
        var sent = await OwnFolder("sentitems", signal);
        // Get the final exact ChangeKey again after attachment hashing and folder resolution.
        var drafts = await OwnFolder("drafts", signal);
        var draft = await Draft(request.DraftId, drafts, request.OperationId, signal);
        if (Revision(draft) != request.Revision) throw new EwsFailure("revision");
        mutationDraftId = request.DraftId;
        await Call("SendItem", new XElement(Messages + "SendItem", new XAttribute("SaveItemToFolder", true),
            new XElement(Messages + "ItemIds", new XElement(Types + "ItemId", new XAttribute("Id", request.DraftId), new XAttribute("ChangeKey", request.Revision))),
            new XElement(Messages + "SavedItemFolderId", new XElement(Types + "FolderId", new XAttribute("Id", sent)))), signal, true);
        // Sending and locating its sent copy are different facts. A slow sent-folder
        // index must never turn a confirmed SendItem into an invitation to resend.
        NativeSubmissionReceipt? receipt = null;
        try {
            receipt = await ReadSubmissionReceipt(new SubmissionReceiptRequest(request.OperationId), signal);
        } catch { /* The original submission receipt remains authoritative. */ }
        return new NativeSubmitResult("submitted", request.OperationId, request.DraftId, request.Revision, receipt?.InternetMessageId, receipt?.SentMessageId);
    }

    // A read-only reconciliation of the exact approved operation. Never sends,
    // edits or chooses a message by subject or by its position in Sent Items.
    public async Task<NativeSubmissionReceipt> ReadSubmissionReceipt(SubmissionReceiptRequest request, CancellationToken signal) {
        if (!ValidOperation(request.OperationId)) throw new EwsFailure("invalid_input");
        var sent = await OwnFolder("sentitems", signal);
        var found = await Call("FindItem", new XElement(Messages + "FindItem", new XAttribute("Traversal", "Shallow"),
            new XElement(Messages + "ItemShape", new XElement(Types + "BaseShape", "IdOnly"), new XElement(Types + "AdditionalProperties", MarkerField())),
            new XElement(Messages + "IndexedPageItemView", new XAttribute("MaxEntriesReturned", 2), new XAttribute("Offset", 0), new XAttribute("BasePoint", "Beginning")),
            new XElement(Messages + "Restriction", new XElement(Types + "IsEqualTo", MarkerField(),
                new XElement(Types + "FieldURIOrConstant", new XElement(Types + "Constant", new XAttribute("Value", request.OperationId))))),
            new XElement(Messages + "ParentFolderIds", new XElement(Types + "FolderId", new XAttribute("Id", sent)))), signal);
        var items = found.Element(Messages + "RootFolder")?.Element(Types + "Items")?.Elements().ToArray() ?? [];
        if (items.Length == 0) return new NativeSubmissionReceipt("pending", request.OperationId);
        if (items.Length != 1) return new NativeSubmissionReceipt("ambiguous", request.OperationId);
        CheckMarker(items[0], request.OperationId);
        var id = Attribute(items[0].Element(Types + "ItemId"), "Id");
        var copy = await GetMessage(id, [MarkerField(), Field("message:InternetMessageId")], signal);
        if (Attribute(copy.Element(Types + "ParentFolderId"), "Id") != sent) throw new EwsFailure("scope");
        CheckMarker(copy, request.OperationId);
        var messageId = ((string?)copy.Element(Types + "InternetMessageId"))?.Trim();
        if (string.IsNullOrEmpty(messageId) || messageId.Length > 4096 || messageId.Any(char.IsControl)) return new NativeSubmissionReceipt("pending", request.OperationId);
        return new NativeSubmissionReceipt("found", request.OperationId, messageId, id);
    }
}
