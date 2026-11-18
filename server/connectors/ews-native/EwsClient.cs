using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using System.Security.Cryptography.Pkcs;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;

namespace AnotherRae.Ews;

public sealed record MailCertificate(string Pkcs12Base64, string Password);
public sealed record MailCredentials(string Endpoint, string Username, string Password, MailCertificate? Certificate = null);
public sealed record PendingMail(string Id, string Revision);
public sealed record MailCursor(int Version, string FolderId, string Since, string? SyncState, bool Catchup, PendingMail[] Pending);
public sealed record MailQuery(string FolderId, string? Subject = null, int Offset = 0, int Limit = 10);
public sealed record MailRead(string FolderId, string MessageId);
public sealed record NativeRequest(string Operation, MailCredentials Credentials, MailCursor? Cursor = null, MailQuery? Query = null, MailRead? Read = null,
    MailInfoRequest? Info = null, MailAttachmentListRequest? Attachments = null, MailAttachmentReadRequest? Attachment = null,
    PrepareMessageRequest? Prepare = null, AttachFileRequest? Attach = null, InspectDraftRequest? Inspect = null, SubmitDraftRequest? Submit = null,
    SubmissionReceiptRequest? Submission = null) {
    public int PayloadCount => new object?[] { Cursor, Query, Read, Info, Attachments, Attachment, Prepare, Attach, Inspect, Submit, Submission }.Count(value => value is not null);
}
public sealed record MailFolder(string Id, string DisplayName, int TotalCount, int UnreadCount);
public sealed record MailSummary(string Id, string Revision, string Subject, string ReceivedAt, string Sender, string EncryptionHint, bool IsRead);
public sealed record QueryOutput(MailSummary[] Messages, int? NextOffset, int TotalItems);
public sealed record MailChange(string Id, string Revision, string Subject, string ReceivedAt, string Sender, string Body,
    string Encryption, string BodyStatus, bool Truncated, int TotalCharacters, string? InternetMessageId = null,
    string? InReplyTo = null, string? References = null, string? SenderAddress = null);
public sealed record ScanOutput(MailCursor Cursor, MailChange[] Changes, bool More);
public sealed class EwsFailure(string code, string? ewsCode = null, bool dispatched = false, bool outcomeUnknown = false,
    string? draftId = null) : Exception {
    public string Code { get; } = code;
    public string? EwsCode { get; } = ewsCode;
    public bool Dispatched { get; } = dispatched;
    public bool OutcomeUnknown { get; } = outcomeUnknown;
    public string? DraftId { get; } = draftId;
}

public sealed partial class EwsClient : IDisposable {
    public const int MaximumBodyCharacters = 60_000;
    public const int MaximumMessageBytes = 24 * 1024 * 1024;
    public const int MaximumAttachmentBytes = 5 * 1024 * 1024;
    public const int MaximumOutgoingAttachmentBytes = 10 * 1024 * 1024;
    bool mutationDispatched;
    bool mutationAccepted;
    string? mutationDraftId;
    public static readonly XNamespace Soap = "http://schemas.xmlsoap.org/soap/envelope/";
    public static readonly XNamespace Messages = "http://schemas.microsoft.com/exchange/services/2006/messages";
    public static readonly XNamespace Types = "http://schemas.microsoft.com/exchange/services/2006/types";
    readonly Uri endpoint;
    readonly HttpClient http;
    readonly X509Certificate2Collection certificates = [];
    readonly NetworkCredential credentials;

    public EwsClient(MailCredentials selected, HttpMessageHandler? fixture = null) {
        if (fixture is null && Environment.GetEnvironmentVariable("RAE_OFFLINE_TESTS") == "1") throw new EwsFailure("offline");
        if (!Uri.TryCreate(selected.Endpoint, UriKind.Absolute, out var uri) || uri.Scheme != "https" || uri.Port != 443
            || uri.UserInfo.Length != 0 || uri.Query.Length != 0 || uri.Fragment.Length != 0
            || !uri.AbsolutePath.Equals("/EWS/Exchange.asmx", StringComparison.OrdinalIgnoreCase)
            || selected.Endpoint.Any(char.IsControl) || selected.Endpoint.Contains('\\')
            || string.IsNullOrWhiteSpace(selected.Username) || selected.Username.Length > 320
            || selected.Username.Any(char.IsControl) || selected.Username.Contains(':')
            || string.IsNullOrEmpty(selected.Password) || selected.Password.Length > 1024 || selected.Password.Contains('\0')) {
            throw new EwsFailure("invalid_input");
        }
        endpoint = uri;
        if (selected.Certificate is { } certificate) {
            byte[]? bytes = null;
            try {
                if (certificate.Pkcs12Base64.Length > 1_398_104 || certificate.Password.Length > 1024) throw new EwsFailure("certificate");
                bytes = Convert.FromBase64String(certificate.Pkcs12Base64);
                if (bytes.Length > 1024 * 1024) throw new EwsFailure("certificate");
                certificates = X509CertificateLoader.LoadPkcs12Collection(bytes, certificate.Password,
                    X509KeyStorageFlags.EphemeralKeySet);
                if (certificates.Count > 20 || !certificates.Any(item => item.HasPrivateKey)) throw new EwsFailure("certificate");
            } catch {
                foreach (var item in certificates) item.Dispose();
                throw new EwsFailure("certificate");
            } finally { if (bytes is not null) CryptographicOperations.ZeroMemory(bytes); }
        }
        var slash = selected.Username.IndexOf('\\');
        credentials = slash < 0 ? new NetworkCredential(selected.Username, selected.Password)
            : new NetworkCredential(selected.Username[(slash + 1)..], selected.Password, selected.Username[..slash]);
        var cache = new CredentialCache { { endpoint, "NTLM", credentials } };
        http = new HttpClient(fixture ?? new HttpClientHandler {
            UseDefaultCredentials = false, Credentials = cache, PreAuthenticate = false,
            AllowAutoRedirect = false, UseCookies = false, UseProxy = false,
            ClientCertificateOptions = ClientCertificateOption.Manual
        }) { Timeout = Timeout.InfiniteTimeSpan };
    }

    static XElement Field(string value) => new(Types + "FieldURI", new XAttribute("FieldURI", value));
    static string Required(XElement parent, XName name, int max = 4096) {
        var items = parent.Elements(name).ToArray();
        if (items.Length != 1 || string.IsNullOrEmpty(items[0].Value) || items[0].Value.Length > max) throw new EwsFailure("invalid_response");
        return items[0].Value;
    }
    static string Attribute(XElement? element, string name, int max = 4096) {
        var value = (string?)element?.Attribute(name);
        if (string.IsNullOrEmpty(value) || value.Length > max || value.Any(char.IsControl)) throw new EwsFailure("invalid_response");
        return value;
    }
    static int Count(XElement parent, XName name) => int.TryParse(Required(parent, name, 10), NumberStyles.None,
        CultureInfo.InvariantCulture, out var result) && result >= 0 ? result : throw new EwsFailure("invalid_response");
    static bool Boolean(XElement parent, XName name) => Required(parent, name, 5) switch {
        "true" => true, "false" => false, _ => throw new EwsFailure("invalid_response")
    };
    static int AttributeCount(XElement element, string name) => int.TryParse(Attribute(element, name, 10), NumberStyles.None,
        CultureInfo.InvariantCulture, out var result) && result >= 0 ? result : throw new EwsFailure("invalid_response");
    static bool ValidId(string? value) => !string.IsNullOrEmpty(value) && value.Length <= 4096 && !value.Any(char.IsControl);
    static string Subject(XElement item) {
        var subject = (string?)item.Element(Types + "Subject") ?? "（无主题）";
        return subject[..Math.Min(subject.Length, 240)];
    }
    static string Sender(XElement item) {
        var mailbox = item.Element(Types + "From")?.Element(Types + "Mailbox");
        var from = string.Join(" ", new[] { (string?)mailbox?.Element(Types + "Name"), (string?)mailbox?.Element(Types + "EmailAddress") }
            .Where(value => !string.IsNullOrEmpty(value)));
        return from[..Math.Min(from.Length, 400)];
    }
    static DateTimeOffset ReceivedAt(XElement item) => DateTimeOffset.TryParse(Required(item, Types + "DateTimeReceived", 100),
        CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var date) ? date : throw new EwsFailure("invalid_response");

    public EwsFailure Annotate(EwsFailure error) => new(error.Code, error.EwsCode,
        error.Dispatched || mutationDispatched,
        error.OutcomeUnknown || mutationAccepted || mutationDispatched && error.Code is "timeout" or "transport" or "invalid_response" or "response_limit" or "http",
        error.DraftId ?? mutationDraftId);

    async Task<XElement> Call(string operation, XElement body, CancellationToken signal, bool mutating = false) {
        signal.ThrowIfCancellationRequested();
        var xml = new XElement(Soap + "Envelope", new XAttribute(XNamespace.Xmlns + "s", Soap),
            new XAttribute(XNamespace.Xmlns + "m", Messages), new XAttribute(XNamespace.Xmlns + "t", Types),
            new XElement(Soap + "Header", new XElement(Types + "RequestServerVersion", new XAttribute("Version", "Exchange2013_SP1"))),
            new XElement(Soap + "Body", body));
        using var request = new HttpRequestMessage(HttpMethod.Post, endpoint) {
            Version = HttpVersion.Version11, VersionPolicy = HttpVersionPolicy.RequestVersionExact,
            Content = new StringContent(xml.ToString(SaveOptions.DisableFormatting), Encoding.UTF8, "text/xml")
        };
        request.Headers.UserAgent.ParseAdd("AnotherRae-EWS/1.0");
        request.Headers.Add("SOAPAction", Messages.NamespaceName + "/" + operation);
        HttpResponseMessage response;
        if (mutating) mutationDispatched = true;
        try { response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, signal); }
        catch (HttpRequestException) { throw new EwsFailure("transport"); }
        using (response) {
            if (response.StatusCode == HttpStatusCode.Unauthorized) throw new EwsFailure("authentication");
            if (response.StatusCode == HttpStatusCode.Forbidden) throw new EwsFailure("forbidden");
            if (response.StatusCode == HttpStatusCode.TooManyRequests) throw new EwsFailure("throttled");
            if (response.StatusCode != HttpStatusCode.OK) throw new EwsFailure("http");
            if (response.Content.Headers.ContentLength > MaximumMessageBytes) throw new EwsFailure("response_limit");
            using var stream = await response.Content.ReadAsStreamAsync(signal);
            using var memory = new MemoryStream();
            var buffer = new byte[8192]; int count;
            while ((count = await stream.ReadAsync(buffer, signal)) != 0) {
                if (memory.Length + count > MaximumMessageBytes) throw new EwsFailure("response_limit");
                memory.Write(buffer, 0, count);
            }
            memory.Position = 0;
            using var reader = XmlReader.Create(memory, new XmlReaderSettings {
                DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = MaximumMessageBytes
            });
            var document = XDocument.Load(reader);
            var results = document.Element(Soap + "Envelope")?.Element(Soap + "Body")?.Element(Messages + operation + "Response")
                ?.Element(Messages + "ResponseMessages")?.Elements(Messages + operation + "ResponseMessage").ToArray();
            if (results is null || results.Length != 1) throw new EwsFailure("invalid_response");
            var result = results[0];
            var code = Required(result, Messages + "ResponseCode", 100);
            if ((string?)result.Attribute("ResponseClass") != "Success" || code != "NoError") {
                throw new EwsFailure("ews", Regex.IsMatch(code, "^Error[A-Za-z]{1,80}$") ? code : null);
            }
            if (mutating) mutationAccepted = true;
            return result;
        }
    }

    public async Task<MailFolder> Baseline(CancellationToken signal) {
        var response = await Call("GetFolder", new XElement(Messages + "GetFolder",
            new XElement(Messages + "FolderShape", new XElement(Types + "BaseShape", "IdOnly"),
                new XElement(Types + "AdditionalProperties", Field("folder:DisplayName"), Field("folder:TotalCount"), Field("folder:UnreadCount"))),
            new XElement(Messages + "FolderIds", new XElement(Types + "DistinguishedFolderId", new XAttribute("Id", "inbox")))), signal);
        var folders = response.Element(Messages + "Folders")?.Elements(Types + "Folder").ToArray();
        if (folders is null || folders.Length != 1) throw new EwsFailure("invalid_response");
        var folder = folders[0];
        return new MailFolder(Attribute(folder.Element(Types + "FolderId"), "Id"), Required(folder, Types + "DisplayName", 300),
            Count(folder, Types + "TotalCount"), Count(folder, Types + "UnreadCount"));
    }

    async Task CheckInbox(string folderId, CancellationToken signal) {
        if (!ValidId(folderId)) throw new EwsFailure("invalid_input");
        if ((await Baseline(signal)).Id != folderId) throw new EwsFailure("scope");
    }

    public async Task<QueryOutput> Query(MailQuery query, CancellationToken signal) {
        if (query.Offset < 0 || query.Offset > 10_000 || query.Limit < 1 || query.Limit > 25
            || query.Subject is not null && (string.IsNullOrWhiteSpace(query.Subject) || query.Subject.Length > 240 || query.Subject.Any(char.IsControl))) {
            throw new EwsFailure("invalid_input");
        }
        await CheckInbox(query.FolderId, signal);
        var response = await Call("FindItem", new XElement(Messages + "FindItem", new XAttribute("Traversal", "Shallow"),
            new XElement(Messages + "ItemShape", new XElement(Types + "BaseShape", "IdOnly"),
                new XElement(Types + "AdditionalProperties", Field("item:ParentFolderId"), Field("item:Subject"), Field("item:DateTimeReceived"),
                    Field("message:From"), Field("message:IsRead"), Field("item:ItemClass"))),
            new XElement(Messages + "IndexedPageItemView", new XAttribute("MaxEntriesReturned", query.Limit),
                new XAttribute("Offset", query.Offset), new XAttribute("BasePoint", "Beginning")),
            query.Subject is null ? null : new XElement(Messages + "Restriction",
                new XElement(Types + "Contains", new XAttribute("ContainmentMode", "Substring"), new XAttribute("ContainmentComparison", "IgnoreCase"),
                    Field("item:Subject"), new XElement(Types + "Constant", new XAttribute("Value", query.Subject)))),
            new XElement(Messages + "SortOrder", new XElement(Types + "FieldOrder", new XAttribute("Order", "Descending"), Field("item:DateTimeReceived"))),
            new XElement(Messages + "ParentFolderIds", new XElement(Types + "FolderId", new XAttribute("Id", query.FolderId)))), signal);
        var roots = response.Elements(Messages + "RootFolder").ToArray();
        if (roots.Length != 1) throw new EwsFailure("invalid_response");
        var root = roots[0];
        var items = root.Element(Types + "Items")?.Elements().ToArray() ?? [];
        if (items.Length > query.Limit) throw new EwsFailure("invalid_response");
        var total = AttributeCount(root, "TotalItemsInView");
        var complete = Attribute(root, "IncludesLastItemInRange", 5) switch {
            "true" => true, "false" => false, _ => throw new EwsFailure("invalid_response")
        };
        int? nextOffset = null;
        if (!complete) {
            var next = root.Attribute("IndexedPagingOffset") is null ? checked(query.Offset + items.Length) : AttributeCount(root, "IndexedPagingOffset");
            if (next <= query.Offset || items.Length == 0) throw new EwsFailure("invalid_response");
            if (next <= 10_000) nextOffset = next;
        }
        var messages = new List<MailSummary>();
        foreach (var item in items) {
            if (Attribute(item.Element(Types + "ParentFolderId"), "Id") != query.FolderId) continue;
            var id = item.Element(Types + "ItemId");
            var itemClass = (string?)item.Element(Types + "ItemClass") ?? "";
            messages.Add(new MailSummary(Attribute(id, "Id"), Attribute(id, "ChangeKey"), Subject(item), ReceivedAt(item).ToString("O"),
                Sender(item), itemClass.StartsWith("IPM.Note.SMIME", StringComparison.OrdinalIgnoreCase) ? "smime" : "none", Boolean(item, Types + "IsRead")));
        }
        return new QueryOutput(messages.ToArray(), nextOffset, total);
    }

    public async Task<MailChange?> ReadSelected(MailRead read, CancellationToken signal) {
        if (!ValidId(read.MessageId)) throw new EwsFailure("invalid_input");
        await CheckInbox(read.FolderId, signal);
        XElement preflight;
        try {
            preflight = await Call("GetItem", new XElement(Messages + "GetItem",
                new XElement(Messages + "ItemShape", new XElement(Types + "BaseShape", "IdOnly"),
                    new XElement(Types + "AdditionalProperties", Field("item:ParentFolderId"))),
                new XElement(Messages + "ItemIds", new XElement(Types + "ItemId", new XAttribute("Id", read.MessageId)))), signal);
        } catch (EwsFailure error) when (error.EwsCode == "ErrorItemNotFound") { return null; }
        var items = preflight.Element(Messages + "Items")?.Elements().ToArray();
        if (items is null || items.Length != 1) throw new EwsFailure("invalid_response");
        var item = items[0];
        var id = item.Element(Types + "ItemId");
        if (Attribute(id, "Id") != read.MessageId) throw new EwsFailure("invalid_response");
        if (Attribute(item.Element(Types + "ParentFolderId"), "Id") != read.FolderId) return null;
        return await Read(new PendingMail(read.MessageId, Attribute(id, "ChangeKey")), read.FolderId, null, signal);
    }

    public async Task<ScanOutput> Scan(MailCursor cursor, CancellationToken signal) {
        if (cursor.Version != 1 || string.IsNullOrEmpty(cursor.FolderId) || cursor.FolderId.Length > 4096
            || !DateTimeOffset.TryParse(cursor.Since, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var since)
            || cursor.SyncState?.Length > 262144 || cursor.Pending.Length > 512
            || cursor.Pending.Any(item => string.IsNullOrEmpty(item.Id) || item.Id.Length > 4096 || item.Revision.Length > 4096)) throw new EwsFailure("invalid_input");
        var pending = cursor.Pending.ToList();
        if (pending.Count == 0) {
            var body = new XElement(Messages + "SyncFolderItems",
                new XElement(Messages + "ItemShape", new XElement(Types + "BaseShape", "IdOnly"),
                    new XElement(Types + "AdditionalProperties", Field("item:DateTimeReceived"))),
                new XElement(Messages + "SyncFolderId", new XElement(Types + "FolderId", new XAttribute("Id", cursor.FolderId))),
                cursor.SyncState is null ? null : new XElement(Messages + "SyncState", cursor.SyncState),
                new XElement(Messages + "MaxChangesReturned", cursor.Catchup ? 512 : 100),
                new XElement(Messages + "SyncScope", "NormalItems"));
            var page = await Call("SyncFolderItems", body, signal);
            var state = Required(page, Messages + "SyncState", 262144);
            var complete = Boolean(page, Messages + "IncludesLastItemInRange");
            var changes = page.Element(Messages + "Changes")?.Elements().ToArray() ?? [];
            if (changes.Length > (cursor.Catchup ? 512 : 100)) throw new EwsFailure("invalid_response");
            foreach (var change in changes.Where(change => change.Name == Types + "Create")) {
                var item = change.Elements().SingleOrDefault();
                if (item is null) throw new EwsFailure("invalid_response");
                var received = Required(item, Types + "DateTimeReceived", 100);
                if (!DateTimeOffset.TryParse(received, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var date)) throw new EwsFailure("invalid_response");
                if (date < since) continue;
                var id = item.Element(Types + "ItemId");
                pending.Add(new PendingMail(Attribute(id, "Id"), Attribute(id, "ChangeKey")));
            }
            cursor = cursor with { SyncState = state, Catchup = !complete };
        }
        var output = new List<MailChange>();
        foreach (var candidate in pending.Take(6)) {
            signal.ThrowIfCancellationRequested();
            var mail = await Read(candidate, cursor.FolderId, since, signal);
            if (mail is not null) output.Add(mail);
        }
        cursor = cursor with { Pending = pending.Skip(6).ToArray() };
        return new ScanOutput(cursor, output.ToArray(), cursor.Catchup || cursor.Pending.Length > 0);
    }

    async Task<MailChange?> Read(PendingMail selected, string folderId, DateTimeOffset? since, CancellationToken signal) {
        XElement result;
        try {
            result = await Call("GetItem", new XElement(Messages + "GetItem",
                new XElement(Messages + "ItemShape", new XElement(Types + "BaseShape", "IdOnly"), new XElement(Types + "BodyType", "Text"),
                    new XElement(Types + "AdditionalProperties", Field("item:ParentFolderId"), Field("item:Subject"), Field("item:DateTimeReceived"),
                        Field("message:From"), Field("message:InternetMessageId"), Field("item:InReplyTo"), Field("message:References"),
                        Field("item:ItemClass"), Field("item:Body"), Field("item:Attachments"))),
                new XElement(Messages + "ItemIds", new XElement(Types + "ItemId", new XAttribute("Id", selected.Id)))), signal);
        } catch (EwsFailure error) when (error.EwsCode == "ErrorItemNotFound") { return null; }
        var items = result.Element(Messages + "Items")?.Elements().ToArray();
        if (items is null || items.Length != 1) throw new EwsFailure("invalid_response");
        var item = items[0];
        if (Attribute(item.Element(Types + "ItemId"), "Id") != selected.Id) throw new EwsFailure("invalid_response");
        // Do not publish a late result for an item that left the authorized Inbox.
        if (Attribute(item.Element(Types + "ParentFolderId"), "Id") != folderId) return null;
        var receivedAt = ReceivedAt(item);
        if (since is { } cutoff && receivedAt < cutoff) return null;
        var text = (string?)item.Element(Types + "Body") ?? "";
        var encryption = "none"; var status = "read";
        if (OpaqueSmime(item)) {
            encryption = "smime";
            try {
                using var content = await LoadSmimePayload(selected.Id, item, signal);
                encryption = content.Encryption;
                text = MailContent.ReadText(content.Content);
            } catch (EwsFailure error) when (error.Code is "certificate_missing" or "decrypt" or "mime" or "smime_container" or "response_limit") {
                text = ""; status = error.Code;
            } catch (CryptographicException) { text = ""; status = "decrypt"; }
        }
        if (text.Length == 0 && status == "read") status = "empty";
        return new MailChange(selected.Id, Revision(item), Subject(item), receivedAt.ToString("O"),
            Sender(item), text[..Math.Min(text.Length, MaximumBodyCharacters)], encryption, status,
            text.Length > MaximumBodyCharacters, text.Length,
            (string?)item.Element(Types + "InternetMessageId"), (string?)item.Element(Types + "InReplyTo"),
            (string?)item.Element(Types + "References"), MailboxAddress(item.Element(Types + "From")?.Element(Types + "Mailbox")));
    }

    public void Dispose() {
        http.Dispose(); credentials.Password = "";
        foreach (var certificate in certificates) certificate.Dispose();
        certificates.Clear();
    }
}
