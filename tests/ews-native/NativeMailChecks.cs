using System.Net;
using System.Security.Cryptography;
using System.Security.Cryptography.Pkcs;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Xml.Linq;
using AnotherRae.Ews;

static class NativeMailChecks {
    static readonly XNamespace T = EwsClient.Types, M = EwsClient.Messages, S = EwsClient.Soap;
    static readonly MailCredentials Credentials = new("https://mail.example.test/EWS/Exchange.asmx", "fixture@example.test", "offline-fixture-only");
    public static async Task<int> Run() {
        var count = 0;
        void Check(bool value, string reason) { if (!value) throw new Exception(reason); count++; }
        async Task<EwsFailure> Fail(Func<Task> work, string code) {
            try { await work(); throw new Exception("Expected native mail failure: " + code); }
            catch (EwsFailure error) { Check(error.Code == code, "Unexpected native mail failure: " + error.Code); return error; }
        }
        PrepareMessageRequest Prepare(string mode) => new("operation-offline", mode, [new("to@example.test")], [], [], "Exact subject", "Exact final body\n可见原文", false,
            mode == "send" ? null : new("inbox-id", "source-id", "source-r1"));
        foreach (var mode in new[] { "send", "reply", "replyAll", "forward" }) {
            var wire = new MailWire(); using var client = new EwsClient(Credentials, wire);
            var draft = await client.PrepareMessage(Prepare(mode), CancellationToken.None);
            Check(draft.Body == Prepare(mode).Body && draft.Subject == "Exact subject" && draft.To.Single().Address == "to@example.test", "Smart response must have exact authored body and recipients");
            Check(draft.Attachments.Length == 0 && !draft.Body.Contains("HIDDEN"), "No inherited quote or attachment survives preparation");
            Check(wire.Writes.All(operation => operation.Name != M + "SendItem") && wire.Writes.First().Attribute("MessageDisposition")!.Value == "SaveOnly", "Preparation only saves a draft");
            var created = wire.Writes.First().Element(M + "Items")!.Elements().Single();
            Check(created.Name.LocalName == (mode switch { "reply" => "ReplyToItem", "replyAll" => "ReplyAllToItem", "forward" => "ForwardItem", _ => "Message" }), "Correct threading API selected");
            Check(!created.Descendants(T + "From").Any(), "Sending uses authenticated Exchange default From");
            if (mode != "send") Check((string?)created.Element(T + "ReferenceItemId")?.Attribute("ChangeKey") == "source-r1", "Smart response is bound to exact source version");
            Check(wire.Source.Element(T + "Attachments")!.Elements().Count() == 1 && wire.Removed.All(id => id.StartsWith("inherited-")), "Only inherited attachments of new draft are removed");
        }
        {
            var wire = new MailWire(); using var client = new EwsClient(Credentials, wire);
            wire.Source.Element(T + "ParentFolderId")!.SetAttributeValue("Id", "outside-folder");
            await Fail(async () => { await client.PrepareMessage(Prepare("reply"), CancellationToken.None); }, "scope");
            Check(wire.Writes.Count == 0, "Source outside Inbox rejected before any draft mutation");
        }
        {
            var wire = new MailWire(); using var client = new EwsClient(Credentials, wire);
            await Fail(async () => { await client.PrepareMessage(Prepare("reply") with { Source = new("inbox-id", "source-id", "stale") }, CancellationToken.None); }, "revision");
            await Fail(async () => { await client.PrepareMessage(Prepare("send") with { To = [new("not-an-address")] }, CancellationToken.None); }, "invalid_input");
            await Fail(async () => { await client.PrepareMessage(Prepare("send") with { Body = new string('x', 200001) }, CancellationToken.None); }, "invalid_input");
            Check(wire.Writes.Count == 0, "Invalid source/recipient/body cannot create draft");
        }
        {
            var wire = new MailWire(); using var client = new EwsClient(Credentials, wire);
            var info = await client.MessageInfo(new("inbox-id", "source-id"), CancellationToken.None);
            Check(info.Revision == "source-r1" && info.ReplyTo.SequenceEqual(["reply@example.test"]) && info.SelfAddress == "owner@example.test", "Reply metadata exposes verified recipient and receiving SMTP identity");
            var page = await client.ListAttachments(new("inbox-id", "source-id"), CancellationToken.None);
            Check(page.Attachments.Length == 1 && page.Attachments[0].Supported && !page.SourceProtected, "Ordinary file listed without protection downgrade");
            var data = await client.ReadAttachment(new("inbox-id", "source-id", page.Revision, page.Attachments[0].Reference), CancellationToken.None);
            Check(Convert.FromBase64String(data.Base64).SequenceEqual(wire.Bytes["source-file"]) && data.Sha256 == Hash(wire.Bytes["source-file"]), "Ordinary attachment byte/hash roundtrip");
            wire.Source.Element(T + "Attachments")!.Add(new XElement(T + "ItemAttachment", new XElement(T + "AttachmentId", new XAttribute("Id", "item-file")),
                new XElement(T + "Name", "nested.eml"), new XElement(T + "Size", 10)));
            page = await client.ListAttachments(new("inbox-id", "source-id"), CancellationToken.None);
            Check(page.Attachments[1].Kind == "item" && !page.Attachments[1].Supported, "ItemAttachment remains visible and explicitly unsupported");
            await Fail(async () => { await client.ReadAttachment(new("inbox-id", "source-id", page.Revision, page.Attachments[1].Reference), CancellationToken.None); }, "unsupported_attachment");
            await Fail(async () => { await client.ReadAttachment(new("inbox-id", "source-id", "stale", page.Attachments[0].Reference), CancellationToken.None); }, "revision");
            wire.Source.Element(T + "ParentFolderId")!.SetAttributeValue("Id", "outside-folder");
            await Fail(async () => { await client.ReadAttachment(new("inbox-id", "source-id", page.Revision, page.Attachments[0].Reference), CancellationToken.None); }, "scope");
        }
        {
            var wire = new MailWire(); using var prepareClient = new EwsClient(Credentials, wire);
            var draft = await prepareClient.PrepareMessage(Prepare("send"), CancellationToken.None);
            var root = Path.Combine(Path.GetTempPath(), "rae-native-mail-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
            try {
                var path = Path.Combine(root, "opaque-artifact"); var bytes = Encoding.UTF8.GetBytes("offline attachment bytes"); File.WriteAllBytes(path, bytes);
                var attach = new AttachFileRequest("operation-offline", draft.DraftId, draft.Revision, new(path, Hash(bytes), bytes.Length, "报告.txt", "text/plain"), root);
                await Fail(async () => { await prepareClient.AttachFile(attach with { File = attach.File with { Sha256 = new string('0', 64) } }, CancellationToken.None); }, "invalid_file");
                Check(!wire.Writes.Any(operation => operation.Name == M + "CreateAttachment"), "Invalid custody digest blocks attachment mutation");
                if (!OperatingSystem.IsWindows()) {
                    var link = Path.Combine(root, "link"); File.CreateSymbolicLink(link, path);
                    await Fail(async () => { await prepareClient.AttachFile(attach with { File = attach.File with { Path = link } }, CancellationToken.None); }, "invalid_file");
                }
                draft = await prepareClient.AttachFile(attach, CancellationToken.None);
                Check(draft.Attachments.Length == 1 && draft.Attachments[0].Name == "报告.txt" && draft.Attachments[0].Sha256 == Hash(bytes), "Draft inspection hashes exact remotely stored bytes");
                var id = draft.Attachments.Single().Id; var oldHash = draft.SnapshotHash; wire.Bytes[id][0] ^= 1;
                // A changed remote payload cannot be authorized with the old snapshot even if a faulty server kept its ChangeKey.
                using (var submitClient = new EwsClient(Credentials, wire.Share())) {
                    await Fail(async () => { await submitClient.SubmitDraft(new("operation-offline", draft.DraftId, draft.Revision, oldHash), CancellationToken.None); }, "snapshot");
                }
                Check(!wire.Writes.Any(operation => operation.Name == M + "SendItem"), "Stale snapshot never sends");
                wire.Bytes[id][0] ^= 1;
                draft = await prepareClient.InspectDraft(new("operation-offline", draft.DraftId), CancellationToken.None);
                var priorMarker = wire.Draft!.Element(T + "ExtendedProperty")!.Element(T + "Value")!.Value;
                wire.Draft.Element(T + "ExtendedProperty")!.Element(T + "Value")!.Value = "another-operation";
                var bodyReads = wire.Requests.Count(operation => operation.Descendants(T + "FieldURI").Any(field => (string?)field.Attribute("FieldURI") == "item:Body"));
                await Fail(async () => { await prepareClient.InspectDraft(new("operation-offline", draft.DraftId), CancellationToken.None); }, "draft_scope");
                Check(wire.Requests.Count(operation => operation.Descendants(T + "FieldURI").Any(field => (string?)field.Attribute("FieldURI") == "item:Body")) == bodyReads, "Wrong marker is rejected before requesting draft body");
                wire.Draft.Element(T + "ExtendedProperty")!.Element(T + "Value")!.Value = priorMarker;
                wire.Draft.Element(T + "ParentFolderId")!.SetAttributeValue("Id", "outside-folder");
                await Fail(async () => { await prepareClient.InspectDraft(new("operation-offline", draft.DraftId), CancellationToken.None); }, "draft_scope");
                wire.Draft.Element(T + "ParentFolderId")!.SetAttributeValue("Id", "drafts-id");
                wire.SendError = "known";
                using (var submitClient = new EwsClient(Credentials, wire.Share())) {
                    var error = await Fail(async () => { await submitClient.SubmitDraft(new("operation-offline", draft.DraftId, draft.Revision, draft.SnapshotHash), CancellationToken.None); }, "ews");
                    error = submitClient.Annotate(error);
                    Check(error.Dispatched && !error.OutcomeUnknown && error.EwsCode == "ErrorAccessDenied", "Explicit SendItem error is dispatched but known rejected");
                }
                wire.SendError = "lost";
                var prior = wire.Writes.Count(operation => operation.Name == M + "SendItem");
                using (var submitClient = new EwsClient(Credentials, wire.Share())) {
                    var error = await Fail(async () => { await submitClient.SubmitDraft(new("operation-offline", draft.DraftId, draft.Revision, draft.SnapshotHash), CancellationToken.None); }, "transport");
                    error = submitClient.Annotate(error);
                    Check(error.Dispatched && error.OutcomeUnknown && error.DraftId == draft.DraftId, "Lost SendItem response is unknown with draft identity");
                }
                Check(wire.Writes.Count(operation => operation.Name == M + "SendItem") == prior + 1, "Unknown SendItem is never retried internally");
                wire.SendError = null;
                using (var submitClient = new EwsClient(Credentials, wire.Share())) {
                    var submitted = await submitClient.SubmitDraft(new("operation-offline", draft.DraftId, draft.Revision, draft.SnapshotHash), CancellationToken.None);
                    Check(submitted.State == "submitted" && submitted.Revision == draft.Revision, "Successful SendItem records submission identity and exact version");
                    Check(submitted.InternetMessageId == "<sent-operation@example.test>", "The accepted send records its actual Internet message ID for reply correlation");
                    var send = wire.Writes.Last();
                    Check((string?)send.Attribute("SaveItemToFolder") == "true" && (string?)send.Element(M + "ItemIds")!.Element(T + "ItemId")!.Attribute("ChangeKey") == draft.Revision
                        && (string?)send.Element(M + "SavedItemFolderId")!.Element(T + "FolderId")!.Attribute("Id") == "sentitems-id", "Submission pins exact draft version and own Sent Items");
                }
                var writesBeforeLookup = wire.Writes.Count;
                using (var receiptClient = new EwsClient(Credentials, wire.Share())) {
                    wire.SentCopies = 0;
                    Check((await receiptClient.ReadSubmissionReceipt(new("operation-offline"), CancellationToken.None)).State == "pending", "A delayed sent index is pending, never another send");
                    wire.SentCopies = 2;
                    Check((await receiptClient.ReadSubmissionReceipt(new("operation-offline"), CancellationToken.None)).State == "ambiguous", "Multiple matching copies cannot be guessed");
                    wire.SentCopies = 1; wire.SentInternetId = null;
                    Check((await receiptClient.ReadSubmissionReceipt(new("operation-offline"), CancellationToken.None)).State == "pending", "A copy without a transport ID is still pending");
                    wire.SentInternetId = "<sent-operation@example.test>"; wire.SentFolder = "outside-folder";
                    await Fail(async () => { await receiptClient.ReadSubmissionReceipt(new("operation-offline"), CancellationToken.None); }, "scope");
                    wire.SentFolder = "sentitems-id"; wire.SentMarker = "another-operation";
                    await Fail(async () => { await receiptClient.ReadSubmissionReceipt(new("operation-offline"), CancellationToken.None); }, "draft_scope");
                    wire.SentMarker = null;
                    var receipt = await receiptClient.ReadSubmissionReceipt(new("operation-offline"), CancellationToken.None);
                    Check(receipt.State == "found" && receipt.InternetMessageId == "<sent-operation@example.test>" && receipt.SentMessageId == "sent-id", "A scoped GetItem resolves the exact sent copy and transport identity");
                }
                Check(wire.Writes.Count == writesBeforeLookup, "All post-submission receipt checks are read-only");
            } finally { Directory.Delete(root, true); }
        }
        {
            using var rsa = RSA.Create(2048);
            var request = new CertificateRequest("CN=offline native mail", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
            using var certificate = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-1), DateTimeOffset.UtcNow.AddMinutes(5));
            var payload = Encoding.UTF8.GetBytes("Content-Type: multipart/mixed; boundary=offline\r\n\r\n--offline\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nvisible body\r\n--offline\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=inner.bin\r\nContent-Transfer-Encoding: base64\r\n\r\nAQIDBAU=\r\n--offline--\r\n");
            var encrypted = new EnvelopedCms(new ContentInfo(payload)); encrypted.Encrypt(new CmsRecipient(certificate));
            var pfx = certificate.Export(X509ContentType.Pkcs12, "offline-only");
            var selected = Credentials with { Certificate = new(Convert.ToBase64String(pfx), "offline-only") };
            var wire = new MailWire(); wire.SetSmime(encrypted.Encode());
            using var client = new EwsClient(selected, wire);
            var page = await client.ListAttachments(new("inbox-id", "source-id"), CancellationToken.None);
            Check(page.SourceProtected && page.Attachments.Single().Name == "inner.bin" && page.Attachments[0].SourceProtected, "Encrypted MIME file is listed as protected inner attachment");
            var file = await client.ReadAttachment(new("inbox-id", "source-id", page.Revision, page.Attachments.Single().Reference), CancellationToken.None);
            Check(Convert.FromBase64String(file.Base64).SequenceEqual(new byte[] { 1, 2, 3, 4, 5 }) && file.SourceProtected, "Encrypted inner attachment reuses selected-certificate decrypt path");
            await Fail(async () => { await client.PrepareMessage(Prepare("forward"), CancellationToken.None); }, "protected_source");
            Check(wire.Writes.Count == 0, "Encrypted source is never silently downgraded to plaintext");
            var prepared = await client.PrepareMessage(Prepare("forward") with { AllowPlaintextProtectedSource = true }, CancellationToken.None);
            Check(prepared.Attachments.Length == 0 && prepared.Body == Prepare("forward").Body, "Explicit protected-source consent yields exact plaintext draft without hidden ciphertext attachment");
            var altered = page.Attachments[0].Reference.Replace(page.Attachments[0].Reference[5..69], new string('0', 64));
            await Fail(async () => { await client.ReadAttachment(new("inbox-id", "source-id", page.Revision, altered), CancellationToken.None); }, "revision");
            var signed = new SignedCms(new ContentInfo(payload)); signed.ComputeSignature(new CmsSigner(certificate));
            wire.SetSmime(signed.Encode());
            using var noCertificate = new EwsClient(Credentials, wire.Share());
            prepared = await noCertificate.PrepareMessage(Prepare("reply"), CancellationToken.None);
            Check(prepared.Body == Prepare("reply").Body, "Signed-only source requires no confidentiality downgrade consent or private key");
            CryptographicOperations.ZeroMemory(pfx);
        }
        return count;
    }
    static string Hash(byte[] value) => Convert.ToHexStringLower(SHA256.HashData(value));

    sealed class SharedHandler(MailWire owner) : HttpMessageHandler {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken signal) => owner.Handle(request, signal);
    }
    sealed class MailWire : HttpMessageHandler {
        public XElement Source { get; } = Message("source-id", "source-r1", "inbox-id");
        public XElement? Draft { get; private set; }
        public Dictionary<string, byte[]> Bytes { get; } = new();
        public List<XElement> Writes { get; } = [];
        public List<XElement> Requests { get; } = [];
        public List<string> Removed { get; } = [];
        public string? SendError { get; set; }
        public int SentCopies { get; set; } = 1;
        public string? SentInternetId { get; set; } = "<sent-operation@example.test>";
        public string SentFolder { get; set; } = "sentitems-id";
        public string? SentMarker { get; set; }
        int revision;
        public MailWire() {
            Source.Add(new XElement(T + "From", Mailbox("sender@example.test")), Recipient("ToRecipients", "owner@example.test"),
                Recipient("ReplyTo", "reply@example.test"), new XElement(T + "ReceivedBy", Mailbox("owner@example.test")));
            Bytes["source-file"] = Encoding.UTF8.GetBytes("offline original file");
            Source.Add(new XElement(T + "Attachments", Attachment("source-file", "source.txt", Bytes["source-file"].Length)));
        }
        public HttpMessageHandler Share() => new SharedHandler(this);
        public void SetSmime(byte[] value) {
            Bytes["smime-file"] = value; Source.Element(T + "ItemClass")!.Value = "IPM.Note.SMIME";
            Source.Element(T + "Attachments")!.ReplaceNodes(Attachment("smime-file", "smime.p7m", value.Length, "application/pkcs7-mime"));
        }
        static XElement Mailbox(string address) => new(T + "Mailbox", new XElement(T + "EmailAddress", address), new XElement(T + "RoutingType", "SMTP"));
        static XElement Recipient(string name, string address) => new(T + name, Mailbox(address));
        static XElement Message(string id, string revision, string folder) => new(T + "Message", new XElement(T + "ItemId", new XAttribute("Id", id), new XAttribute("ChangeKey", revision)),
            new XElement(T + "ParentFolderId", new XAttribute("Id", folder)), new XElement(T + "ItemClass", "IPM.Note"),
            new XElement(T + "Subject", "offline source"), new XElement(T + "DateTimeReceived", "2020-01-01T00:00:00Z"), new XElement(T + "Body", "source body"));
        static XElement Attachment(string id, string name, int size, string type = "application/octet-stream") => new(T + "FileAttachment",
            new XElement(T + "AttachmentId", new XAttribute("Id", id)), new XElement(T + "Name", name), new XElement(T + "ContentType", type),
            new XElement(T + "Size", size), new XElement(T + "IsInline", false));
        static HttpResponseMessage Reply(string operation, params object[] children) => new(HttpStatusCode.OK) { Content = new StringContent(
            new XElement(S + "Envelope", new XElement(S + "Body", new XElement(M + operation + "Response",
                new XElement(M + "ResponseMessages", new XElement(M + operation + "ResponseMessage", new XAttribute("ResponseClass", "Success"),
                    new XElement(M + "ResponseCode", "NoError"), children))))).ToString(), Encoding.UTF8, "text/xml") };
        void Advance() => Draft!.Element(T + "ItemId")!.SetAttributeValue("ChangeKey", "draft-r" + ++revision);
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken signal) => Handle(request, signal);
        public async Task<HttpResponseMessage> Handle(HttpRequestMessage request, CancellationToken signal) {
            signal.ThrowIfCancellationRequested();
            var operation = XDocument.Parse(await request.Content!.ReadAsStringAsync(signal)).Root!.Element(S + "Body")!.Elements().Single();
            Requests.Add(new XElement(operation));
            var name = operation.Name.LocalName;
            if (name == "GetFolder") {
                var selected = operation.Descendants(T + "DistinguishedFolderId").Single().Attribute("Id")!.Value;
                return Reply(name, new XElement(M + "Folders", new XElement(T + "Folder", new XElement(T + "FolderId", new XAttribute("Id", selected + "-id")),
                    new XElement(T + "DisplayName", selected), new XElement(T + "TotalCount", 1), new XElement(T + "UnreadCount", 0))));
            }
            if (name == "GetItem") {
                var id = operation.Element(M + "ItemIds")!.Element(T + "ItemId")!.Attribute("Id")!.Value;
                if (id == "sent-id") {
                    var sent = Message("sent-id", "sent-r1", SentFolder);
                    sent.Add(Draft!.Elements(T + "ExtendedProperty").Select(property => new XElement(property)));
                    if (SentMarker is not null) sent.Element(T + "ExtendedProperty")!.Element(T + "Value")!.Value = SentMarker;
                    if (SentInternetId is not null) sent.Add(new XElement(T + "InternetMessageId", SentInternetId));
                    return Reply(name, new XElement(M + "Items", sent));
                }
                return Reply(name, new XElement(M + "Items", new XElement(id == "source-id" ? Source : Draft ?? throw new Exception("No fixture draft"))));
            }
            if (name == "GetAttachment") {
                var id = operation.Element(M + "AttachmentIds")!.Element(T + "AttachmentId")!.Attribute("Id")!.Value;
                var root = id is "source-file" or "smime-file" ? "source-id" : "draft-id";
                return Reply(name, new XElement(M + "Attachments", new XElement(T + "FileAttachment", new XElement(T + "AttachmentId", new XAttribute("Id", id), new XAttribute("RootItemId", root)),
                    new XElement(T + "Content", Convert.ToBase64String(Bytes[id])))));
            }
            if (name == "FindItem") {
                if ((string?)operation.Element(M + "ParentFolderIds")!.Element(T + "FolderId")!.Attribute("Id") != "sentitems-id") throw new Exception("Receipt lookup left own Sent Items");
                if ((string?)operation.Descendants(T + "Constant").Single().Attribute("Value") != "operation-offline") throw new Exception("Receipt lookup lost its exact operation marker");
                return Reply(name, new XElement(M + "RootFolder", new XElement(T + "Items", Enumerable.Range(0, SentCopies).Select(_ => new XElement(T + "Message",
                    new XElement(T + "ItemId", new XAttribute("Id", "sent-id")),
                    Draft!.Elements(T + "ExtendedProperty").Select(property => new XElement(property)))))));
            }
            Writes.Add(new XElement(operation));
            if (name == "CreateItem") {
                var created = operation.Element(M + "Items")!.Elements().Single();
                Draft = Message("draft-id", "draft-r0", "drafts-id"); Draft.Add(new XElement(T + "IsDraft", true), new XElement(T + "Attachments"));
                foreach (var property in created.Elements().Where(property => property.Name != T + "ReferenceItemId" && property.Name != T + "NewBodyContent")) {
                    Draft.Element(property.Name)?.Remove(); Draft.Add(new XElement(property));
                }
                if (created.Name != T + "Message") {
                    Draft.Element(T + "Body")!.Value = (string?)created.Element(T + "NewBodyContent") + "\nHIDDEN ORIGINAL QUOTE";
                    Draft.Add(Recipient("CcRecipients", "hidden@example.test"));
                    var id = "inherited-" + Writes.Count; Bytes[id] = [7, 8, 9]; Draft.Element(T + "Attachments")!.Add(Attachment(id, "hidden-original.bin", 3));
                }
                Advance(); return Reply(name, new XElement(M + "Items", new XElement(Draft)));
            }
            if (name == "UpdateItem") {
                foreach (var update in operation.Descendants(T + "Updates").Single().Elements()) {
                    var field = update.Element(T + "FieldURI");
                    if (update.Name == T + "DeleteItemField") Draft!.Element(T + field!.Attribute("FieldURI")!.Value.Split(':')[1])?.Remove();
                    else foreach (var value in update.Element(T + "Message")!.Elements()) { Draft!.Element(value.Name)?.Remove(); Draft.Add(new XElement(value)); }
                }
                Advance(); return Reply(name, new XElement(M + "Items", new XElement(Draft!)));
            }
            if (name == "DeleteAttachment") {
                var id = operation.Element(M + "AttachmentIds")!.Element(T + "AttachmentId")!.Attribute("Id")!.Value;
                var found = Draft!.Element(T + "Attachments")!.Elements().Single(item => (string?)item.Element(T + "AttachmentId")?.Attribute("Id") == id);
                found.Remove(); Removed.Add(id); Advance();
                return Reply(name, new XElement(M + "RootItemId", new XAttribute("RootItemId", "draft-id"), new XAttribute("RootItemChangeKey", Draft.Element(T + "ItemId")!.Attribute("ChangeKey")!.Value)));
            }
            if (name == "CreateAttachment") {
                var file = new XElement(operation.Element(M + "Attachments")!.Element(T + "FileAttachment")!); var id = "uploaded-" + Writes.Count;
                Bytes[id] = Convert.FromBase64String(file.Element(T + "Content")!.Value); file.Element(T + "Content")!.Remove();
                file.AddFirst(new XElement(T + "AttachmentId", new XAttribute("Id", id))); file.Add(new XElement(T + "Size", Bytes[id].Length));
                Draft!.Element(T + "Attachments")!.Add(file); Advance();
                return Reply(name, new XElement(M + "Attachments", new XElement(T + "FileAttachment", new XElement(T + "AttachmentId", new XAttribute("Id", id),
                    new XAttribute("RootItemId", "draft-id"), new XAttribute("RootItemChangeKey", Draft.Element(T + "ItemId")!.Attribute("ChangeKey")!.Value)))));
            }
            if (name == "SendItem") {
                if (SendError == "lost") throw new HttpRequestException("offline injected response loss");
                if (SendError == "known") return new(HttpStatusCode.OK) { Content = new StringContent(new XElement(S + "Envelope", new XElement(S + "Body", new XElement(M + "SendItemResponse",
                    new XElement(M + "ResponseMessages", new XElement(M + "SendItemResponseMessage", new XAttribute("ResponseClass", "Error"), new XElement(M + "ResponseCode", "ErrorAccessDenied")))))).ToString()) };
                return Reply(name);
            }
            throw new Exception("Unexpected offline mail operation " + name);
        }
    }
}
