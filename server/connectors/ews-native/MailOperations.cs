namespace AnotherRae.Ews;

public sealed record MailInfoRequest(string FolderId, string MessageId);
public sealed record MailAttachmentListRequest(string FolderId, string MessageId);
public sealed record MailAttachmentReadRequest(string FolderId, string MessageId, string Revision, string Reference);
public sealed record NativeRecipient(string Address, string? Name = null);
public sealed record NativeSource(string FolderId, string MessageId, string Revision);
public sealed record NativeFile(string Path, string Sha256, long Size, string Name, string ContentType);
public sealed record PrepareMessageRequest(string OperationId, string Mode, NativeRecipient[] To, NativeRecipient[] Cc, NativeRecipient[] Bcc,
    string Subject, string Body, bool AllowPlaintextProtectedSource, NativeSource? Source = null);
public sealed record AttachFileRequest(string OperationId, string DraftId, string Revision, NativeFile File, string CustodyRoot);
public sealed record InspectDraftRequest(string OperationId, string DraftId);
public sealed record SubmitDraftRequest(string OperationId, string DraftId, string Revision, string SnapshotHash);
public sealed record SubmissionReceiptRequest(string OperationId);
public sealed record NativeMessageInfo(string MessageId, string Revision, string Subject, string From, string[] To, string[] Cc,
    string[] Bcc, string[] ReplyTo, string? SelfAddress, string InternetMessageId, string Encryption, string BodyStatus,
    string Body, int TotalCharacters, bool Truncated);
public sealed record NativeAttachment(string Reference, string Name, string ContentType, long Size, bool IsInline,
    string Kind, bool Supported, bool SourceProtected, string? UnsupportedReason = null);
public sealed record NativeAttachmentPage(string MessageId, string Revision, bool SourceProtected, NativeAttachment[] Attachments);
public sealed record NativeAttachmentBytes(string Name, string ContentType, long Size, string Sha256, string Base64,
    bool IsInline, bool SourceProtected);
public sealed record NativeDraftAttachment(string Id, string Name, string ContentType, long Size, string Sha256);
public sealed record NativeDraftSnapshot(string OperationId, string DraftId, string Revision, NativeRecipient[] To,
    NativeRecipient[] Cc, NativeRecipient[] Bcc, string Subject, string Body, NativeDraftAttachment[] Attachments, string SnapshotHash);
public sealed record NativeSubmitResult(string State, string OperationId, string DraftId, string Revision, string? InternetMessageId = null, string? SentMessageId = null);
public sealed record NativeSubmissionReceipt(string State, string OperationId, string? InternetMessageId = null, string? SentMessageId = null);
