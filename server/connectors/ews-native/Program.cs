using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using AnotherRae.Ews;

AppContext.SetSwitch("System.Net.Security.UseManagedNtlm", true);
Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
var json = new JsonSerializerOptions {
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
};
try {
    if (Environment.GetEnvironmentVariable("RAE_OFFLINE_TESTS") == "1") throw new EwsFailure("offline");
    using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(18));
    using var input = new MemoryStream();
    var buffer = new byte[8192];
    int read;
    var stdin = Console.OpenStandardInput();
    while ((read = await stdin.ReadAsync(buffer, timeout.Token)) != 0) {
        if (input.Length + read > 4 * 1024 * 1024) throw new EwsFailure("invalid_input");
        input.Write(buffer, 0, read);
    }
    var request = JsonSerializer.Deserialize<NativeRequest>(input.ToArray(), json) ?? throw new EwsFailure("invalid_input");
    if (request.Operation is "message-info" or "list-attachments" or "read-attachment" or "prepare-message" or "attach-file" or "inspect-draft" or "submit-draft" or "submission-receipt") timeout.CancelAfter(TimeSpan.FromSeconds(55));
    if (request.PayloadCount != (request.Operation == "baseline" ? 0 : 1)) throw new EwsFailure("invalid_input");
    using var client = new EwsClient(request.Credentials);
    object? result;
    try {
        result = request.Operation switch {
            "baseline" => await client.Baseline(timeout.Token),
            "scan" when request.Cursor is not null => await client.Scan(request.Cursor, timeout.Token),
            "query" when request.Query is not null => await client.Query(request.Query, timeout.Token),
            "read" when request.Read is not null => await client.ReadSelected(request.Read, timeout.Token),
            "message-info" when request.Info is not null => await client.MessageInfo(request.Info, timeout.Token),
            "list-attachments" when request.Attachments is not null => await client.ListAttachments(request.Attachments, timeout.Token),
            "read-attachment" when request.Attachment is not null => await client.ReadAttachment(request.Attachment, timeout.Token),
            "prepare-message" when request.Prepare is not null => await client.PrepareMessage(request.Prepare, timeout.Token),
            "attach-file" when request.Attach is not null => await client.AttachFile(request.Attach, timeout.Token),
            "inspect-draft" when request.Inspect is not null => await client.InspectDraft(request.Inspect, timeout.Token),
            "submit-draft" when request.Submit is not null => await client.SubmitDraft(request.Submit, timeout.Token),
            "submission-receipt" when request.Submission is not null => await client.ReadSubmissionReceipt(request.Submission, timeout.Token),
            _ => throw new EwsFailure("invalid_input")
        };
    } catch (EwsFailure error) { throw client.Annotate(error); }
    catch (OperationCanceledException) { throw client.Annotate(new EwsFailure("timeout")); }
    catch { throw client.Annotate(new EwsFailure("invalid_response")); }
    Console.Write(JsonSerializer.Serialize(new { ok = true, result }, json));
} catch (EwsFailure error) {
    Console.Write(JsonSerializer.Serialize(new { ok = false, error = error.Code, ewsCode = error.EwsCode,
        dispatched = error.Dispatched, outcomeUnknown = error.OutcomeUnknown, draftId = error.DraftId }, json));
} catch (OperationCanceledException) {
    Console.Write("{\"ok\":false,\"error\":\"timeout\"}");
} catch {
    // Never serialize exception text: native libraries may include credentials,
    // certificate subjects, server paths, HTTP bodies, or message content.
    Console.Write("{\"ok\":false,\"error\":\"invalid_response\"}");
}
