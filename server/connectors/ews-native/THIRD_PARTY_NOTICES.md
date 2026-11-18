# EWS adapter dependencies

This adapter uses the following maintained libraries. Exact NuGet versions and
package integrity hashes are recorded in `packages.lock.json`; build artifacts
are not committed to the repository.

- .NET 10 runtime and System.Security.Cryptography.Pkcs 10.0.14 — Microsoft and
  .NET contributors, MIT license. https://github.com/dotnet/runtime
- MimeKit 4.18.2 — .NET Foundation, Jeffrey Stedfast and contributors, MIT license.
  https://github.com/jstedfast/MimeKit
- BouncyCastle.Cryptography 2.7.0 — Legion of the Bouncy Castle and contributors,
  MIT license. https://github.com/bcgit/bc-csharp

The preparation script copies the .NET runtime's license and third-party notices
and the MimeKit and Bouncy Castle licenses into the published adapter's
`licenses` directory. These notices do not select a license for Tenon.
