using System.Net;
using System.Net.Security;
using System.Security.Cryptography;
using System.Security.Cryptography.Pkcs;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Xml;
using System.Xml.Linq;
using AnotherRae.Ews;

Environment.SetEnvironmentVariable("RAE_OFFLINE_TESTS", "1");
AppContext.SetSwitch("System.Net.Security.UseManagedNtlm", true);
var checks = 0;
void Check(bool value, string reason) { if (!value) throw new Exception(reason); checks++; }
async Task Failure(Func<Task> action, string? expected = null) {
    try { await action(); throw new Exception("Expected failure"); }
    catch (EwsFailure error) { Check(expected is null || error.Code == expected, "Unexpected safe error"); }
}
var m = EwsClient.Messages; var t = EwsClient.Types; var s = EwsClient.Soap;
HttpResponseMessage Reply(string operation, params object[] properties) => new(HttpStatusCode.OK) {
    Content = new StringContent(new XElement(s + "Envelope", new XElement(s + "Body", new XElement(m + (operation + "Response"),
        new XElement(m + "ResponseMessages", new XElement(m + (operation + "ResponseMessage"), new XAttribute("ResponseClass", "Success"),
            new XElement(m + "ResponseCode", "NoError"), properties))))).ToString(), Encoding.UTF8, "text/xml")
};
XElement Item(string id, string folder = "inbox-id", string received = "2026-11-09T01:00:00Z") => new(t + "Message",
    new XElement(t + "ItemId", new XAttribute("Id", id), new XAttribute("ChangeKey", "revision-" + id)),
    new XElement(t + "ParentFolderId", new XAttribute("Id", folder)), new XElement(t + "Subject", "fixture subject"),
    new XElement(t + "DateTimeReceived", received), new XElement(t + "ItemClass", "IPM.Note"), new XElement(t + "Body", "fixture body"));
HttpResponseMessage Inbox() => Reply("GetFolder", new XElement(m + "Folders", new XElement(t + "Folder",
    new XElement(t + "FolderId", new XAttribute("Id", "inbox-id")), new XElement(t + "DisplayName", "收件箱"),
    new XElement(t + "TotalCount", "100"), new XElement(t + "UnreadCount", "2"))));
XElement Metadata(string id, string folder = "inbox-id") => new(t + "Message",
    new XElement(t + "ItemId", new XAttribute("Id", id), new XAttribute("ChangeKey", "current-" + id)),
    new XElement(t + "ParentFolderId", new XAttribute("Id", folder)));
XElement Summary(string id, string folder = "inbox-id", string received = "2020-01-01T00:00:00Z") {
    var item = Item(id, folder, received); item.Element(t + "Body")!.Remove(); item.Add(new XElement(t + "IsRead", true));
    return item;
}
var credentials = new MailCredentials("https://mail.example.test/EWS/Exchange.asmx", "fixture@example.test", "offline-only-password");
var cursor = new MailCursor(1, "inbox-id", "2026-11-09T00:00:00Z", null, true, []);

using (var ntlm = new NegotiateAuthentication(new NegotiateAuthenticationClientOptions {
    Package = "NTLM", Credential = new NetworkCredential("fixture", "offline-only", "OFFLINE"), TargetName = "HTTP/mail.example.test"
})) {
    var firstToken = ntlm.GetOutgoingBlob((byte[]?)null, out var status);
    Check(status == NegotiateAuthenticationStatusCode.ContinueNeeded && firstToken is not null
        && Encoding.ASCII.GetString(firstToken, 0, 7) == "NTLMSSP", "Native NTLM client is available without a domain or network access");
}

await Failure(() => Task.FromResult(new EwsClient(credentials)), "offline");
await Failure(() => Task.FromResult(new EwsClient(credentials with { Endpoint = "http://mail.example.test/EWS/Exchange.asmx" }, new Fake(_ => throw new Exception()))), "invalid_input");
await Failure(() => Task.FromResult(new EwsClient(credentials with { Certificate = new("not-base64", "fixture") }, new Fake(_ => throw new Exception()))), "certificate");

var requests = new List<string>();
using (var client = new EwsClient(credentials, new Fake(async request => {
    Check(request.RequestUri!.AbsoluteUri == credentials.Endpoint, "Exact endpoint required");
    Check(request.Method == HttpMethod.Post, "EWS uses bounded SOAP calls");
    var body = await request.Content!.ReadAsStringAsync(); requests.Add(body);
    Check(body.Contains("DistinguishedFolderId Id=\"inbox\""), "Inbox scope required");
    Check(!body.Contains("GetItem"), "Baseline must not fetch historical mail");
    return Reply("GetFolder", new XElement(m + "Folders", new XElement(t + "Folder",
        new XElement(t + "FolderId", new XAttribute("Id", "inbox-id")), new XElement(t + "DisplayName", "收件箱"),
        new XElement(t + "TotalCount", "10"), new XElement(t + "UnreadCount", "2"))));
}))) {
    var folder = await client.Baseline(CancellationToken.None);
    Check(folder.Id == "inbox-id" && folder.TotalCount == 10, "Folder metadata");
}

var reads = new List<string>(); var syncCalls = 0;
using (var client = new EwsClient(credentials, new Fake(async request => {
    var document = XDocument.Parse(await request.Content!.ReadAsStringAsync());
    var operation = document.Root!.Element(s + "Body")!.Elements().Single();
    if (operation.Name == m + "SyncFolderItems") {
        syncCalls++;
        Check(operation.Element(m + "SyncFolderId")!.Element(t + "FolderId")!.Attribute("Id")!.Value == "inbox-id", "Sync remains in authorized folder");
        var changes = new List<XElement> { new(t + "Create", Item("old", received: "2020-01-01T00:00:00Z")) };
        changes.AddRange(Enumerable.Range(0, 8).Select(index => new XElement(t + "Create", Item("new-" + index))));
        changes.Add(new XElement(t + "Update", Item("updated-old")));
        return Reply("SyncFolderItems", new XElement(m + "SyncState", "cursor-2"), new XElement(m + "IncludesLastItemInRange", true), new XElement(m + "Changes", changes));
    }
    var id = operation.Element(m + "ItemIds")!.Element(t + "ItemId")!.Attribute("Id")!.Value;
    reads.Add(id);
    return Reply("GetItem", new XElement(m + "Items", Item(id, id == "new-7" ? "outside-folder" : "inbox-id")));
}))) {
    var first = await client.Scan(cursor, CancellationToken.None);
    Check(first.Changes.Length == 6 && first.Cursor.Pending.Length == 2 && first.More, "Bounded continuation");
    var second = await client.Scan(first.Cursor, CancellationToken.None);
    Check(second.Changes.Length == 1 && !second.More && syncCalls == 1, "Continuation does not rescan or publish moved mail");
    Check(!reads.Contains("old") && !reads.Contains("updated-old") && reads.Count == 8, "Historical bodies stay unread");
}

var queryCalls = 0;
using (var client = new EwsClient(credentials, new Fake(async request => {
    var operation = XDocument.Parse(await request.Content!.ReadAsStringAsync()).Root!.Element(s + "Body")!.Elements().Single();
    if (operation.Name == m + "GetFolder") return Inbox();
    Check(operation.Name == m + "FindItem", "Query must only list metadata after scope validation"); queryCalls++;
    Check(!operation.ToString().Contains("item:Body") && !operation.ToString().Contains("item:Attachments"), "List never requests body or attachments");
    var view = operation.Element(m + "IndexedPageItemView")!;
    Check((string?)view.Attribute("Offset") == "10" && (string?)view.Attribute("MaxEntriesReturned") == "2", "Bounded list paging");
    Check(operation.Element(m + "ParentFolderIds")!.Element(t + "FolderId")!.Attribute("Id")!.Value == "inbox-id", "List stays in exact Inbox");
    Check((string?)operation.Element(m + "SortOrder")!.Element(t + "FieldOrder")!.Attribute("Order") == "Descending", "List starts with latest mail");
    Check((string?)operation.Element(m + "Restriction")!.Element(t + "Contains")!.Element(t + "Constant")!.Attribute("Value") == "EPAI & <draft>", "Subject query is escaped as XML data");
    return Reply("FindItem", new XElement(m + "RootFolder", new XAttribute("TotalItemsInView", "42"), new XAttribute("IndexedPagingOffset", "12"),
        new XAttribute("IncludesLastItemInRange", "false"), new XElement(t + "Items", Summary("historical-mail"), Summary("not-in-inbox", "outside-folder"))));
}))) {
    var page = await client.Query(new MailQuery("inbox-id", "EPAI & <draft>", 10, 2), CancellationToken.None);
    Check(page.Messages.Length == 1 && page.Messages[0].Id == "historical-mail" && page.Messages[0].ReceivedAt.StartsWith("2020-"), "Owner list includes existing Inbox mail without passive date fence");
    Check(page.NextOffset == 12 && page.TotalItems == 42 && queryCalls == 1, "Native server pagination preserved after discarded out-of-scope result");
    Check(page.Messages[0].IsRead && page.Messages[0].EncryptionHint == "none", "List includes message state without modifying it");
}
using (var client = new EwsClient(credentials, new Fake(_ => Task.FromResult(Inbox())))) {
    await Failure(async () => { await client.Query(new MailQuery("inbox-id", Limit: 26), CancellationToken.None); }, "invalid_input");
    await Failure(async () => { await client.Query(new MailQuery("inbox-id", Offset: 10_001), CancellationToken.None); }, "invalid_input");
    await Failure(async () => { await client.Query(new MailQuery("different-folder"), CancellationToken.None); }, "scope");
}
foreach (var outsideAt in new[] { "never", "preflight", "body" }) {
    var bodyReads = 0; var metadataReads = 0;
    using var client = new EwsClient(credentials, new Fake(async request => {
        var operation = XDocument.Parse(await request.Content!.ReadAsStringAsync()).Root!.Element(s + "Body")!.Elements().Single();
        if (operation.Name == m + "GetFolder") return Inbox();
        Check(operation.Name == m + "GetItem", "Owner read uses only item reads");
        var properties = operation.Element(m + "ItemShape")!.ToString();
        if (!properties.Contains("item:Body")) {
            metadataReads++; Check(!properties.Contains("item:Attachments"), "Membership check excludes encrypted containers");
            return Reply("GetItem", new XElement(m + "Items", Metadata("historical-mail", outsideAt == "preflight" ? "outside-folder" : "inbox-id")));
        }
        bodyReads++;
        return Reply("GetItem", new XElement(m + "Items", Item("historical-mail", outsideAt == "body" ? "outside-folder" : "inbox-id", "2020-01-01T00:00:00Z")));
    }));
    var read = await client.ReadSelected(new MailRead("inbox-id", "historical-mail"), CancellationToken.None);
    Check(metadataReads == 1 && bodyReads == (outsideAt == "preflight" ? 0 : 1), "Inbox membership is rechecked before requesting a body");
    Check(outsideAt == "never" ? read?.Body == "fixture body" && read.ReceivedAt.StartsWith("2020-") : read is null,
        "Historical read uses shared body path and discards a moved item");
}

foreach (var (status, expected) in new[] { (HttpStatusCode.Unauthorized, "authentication"), (HttpStatusCode.Forbidden, "forbidden"), (HttpStatusCode.Redirect, "http") }) {
    var calls = 0;
    using var client = new EwsClient(credentials, new Fake(_ => { calls++; return Task.FromResult(new HttpResponseMessage(status)); }));
    await Failure(async () => { await client.Baseline(CancellationToken.None); }, expected);
    Check(calls == 1, "No retry or redirect");
}
using (var client = new EwsClient(credentials, new Fake(_ => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) {
    Content = new StringContent("<!DOCTYPE x [<!ENTITY x SYSTEM 'file:///never-read'>]><x>&x;</x>")
})))) {
    try { await client.Baseline(CancellationToken.None); throw new Exception("DTD accepted"); }
    catch (XmlException) { checks++; }
}

using var rsa = RSA.Create(2048);
var certificateRequest = new CertificateRequest("CN=Offline EWS fixture", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
using var certificate = certificateRequest.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-1), DateTimeOffset.UtcNow.AddMinutes(10));
var plain = Encoding.UTF8.GetBytes("Content-Type: text/plain; charset=utf-8\r\n\r\n离线正文，不是邮件数据。");
var signed = new SignedCms(new ContentInfo(plain), false); signed.ComputeSignature(new CmsSigner(certificate));
var signedMime = Encoding.ASCII.GetBytes("Content-Type: application/x-pkcs7-mime; smime-type=signed-data\r\nContent-Transfer-Encoding: base64\r\n\r\n" + Convert.ToBase64String(signed.Encode()));
var encrypted = new EnvelopedCms(new ContentInfo(signedMime)); encrypted.Encrypt(new CmsRecipient(certificate));
var fixturePfx = certificate.Export(X509ContentType.Pkcs12, "offline-fixture-pfx");
var loaded = X509CertificateLoader.LoadPkcs12Collection(fixturePfx, "offline-fixture-pfx", X509KeyStorageFlags.EphemeralKeySet);
try {
    var decoded = MailContent.Unprotect(encrypted.Encode(), loaded);
    Check(decoded.Kind == "smime-decrypted", "S/MIME encryption recognized");
    Check(MailContent.ReadText(decoded.Content) == "离线正文，不是邮件数据。", "Encrypted signed MIME decoded");
    Check(MailContent.ReadText(Encoding.UTF8.GetBytes("Content-Type: text/html; charset=utf-8\r\n\r\n<html><head>ignore</head><body><p>正文 &amp; 内容</p><script>ignore_script</script></body></html>")).Contains("正文 & 内容"), "HTML body extracted");
    Check(!MailContent.ReadText(Encoding.UTF8.GetBytes("Content-Type: text/html; charset=utf-8\r\n\r\n<script>do-not-run</script><p>safe</p>")).Contains("do-not-run"), "No script content in text");
    await Failure(() => Task.FromResult(MailContent.Unprotect(encrypted.Encode(), [])), "certificate_missing");
    Check(MailContent.Unprotect(signed.Encode(), []).Kind == "smime-signed-unverified", "Opaque signing is not encryption");
    var containerReads = 0;
    using var selectedReader = new EwsClient(credentials with { Certificate = new(Convert.ToBase64String(fixturePfx), "offline-fixture-pfx") }, new Fake(async request => {
        var operation = XDocument.Parse(await request.Content!.ReadAsStringAsync()).Root!.Element(s + "Body")!.Elements().Single();
        if (operation.Name == m + "GetFolder") return Inbox();
        if (operation.Name == m + "GetItem") {
            if (!operation.Element(m + "ItemShape")!.ToString().Contains("item:Body")) return Reply("GetItem", new XElement(m + "Items", Metadata("historical-encrypted")));
            var item = Item("historical-encrypted", received: "2020-01-01T00:00:00Z");
            item.Element(t + "ItemClass")!.Value = "IPM.Note.SMIME"; item.Element(t + "Body")!.Value = "";
            item.Add(new XElement(t + "Attachments", new XElement(t + "FileAttachment",
                new XElement(t + "AttachmentId", new XAttribute("Id", "encrypted-body-id")), new XElement(t + "ContentType", "application/pkcs7-mime"),
                new XElement(t + "Size", encrypted.Encode().Length))));
            return Reply("GetItem", new XElement(m + "Items", item));
        }
        Check(operation.Name == m + "GetAttachment", "Historical encrypted read only fetches its selected body container");
        Check(operation.Element(m + "AttachmentIds")!.Element(t + "AttachmentId")!.Attribute("Id")!.Value == "encrypted-body-id", "Only selected S/MIME container is fetched");
        containerReads++;
        return Reply("GetAttachment", new XElement(m + "Attachments", new XElement(t + "FileAttachment",
            new XElement(t + "AttachmentId", new XAttribute("Id", "encrypted-body-id"), new XAttribute("RootItemId", "historical-encrypted")),
            new XElement(t + "Content", Convert.ToBase64String(encrypted.Encode())))));
    }));
    var selectedMail = await selectedReader.ReadSelected(new MailRead("inbox-id", "historical-encrypted"), CancellationToken.None);
    Check(selectedMail?.Encryption == "smime-decrypted" && selectedMail.BodyStatus == "read"
        && selectedMail.Body == "离线正文，不是邮件数据。" && containerReads == 1, "Historical owner read shares complete S/MIME decryption path");
} finally { foreach (var item in loaded) item.Dispose(); CryptographicOperations.ZeroMemory(fixturePfx); }
checks += await NativeMailChecks.Run();
Console.WriteLine($"Native EWS checks passed: {checks}; real network calls: 0; persistent keys: 0.");

sealed class Fake(Func<HttpRequestMessage, Task<HttpResponseMessage>> handler) : HttpMessageHandler {
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken signal) {
        signal.ThrowIfCancellationRequested(); return handler(request);
    }
}
