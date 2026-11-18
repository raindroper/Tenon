/** Immutable official Codex app-server distributions and their complete runtime layouts. */
export const CODEX_RUNTIME = {
  version: '0.169.0',
  executable: 'bin/codex-app-server.exe',
  archiveUrl: 'https://github.com/openai/codex/releases/download/rust-v0.169.0/codex-app-server-package-x86_64-pc-windows-msvc.tar.gz',
  archiveSha256: '37ad913838d7755929802aa7137dc25560a6c246578d014273a450669491b5df',
  executableSha256: '3a03a83858a328842bf45dcce4259baf04840ef518d565b15825ab9e456e9fd6',
  requiredFiles: {
    'bin/codex-app-server.exe': '3a03a83858a328842bf45dcce4259baf04840ef518d565b15825ab9e456e9fd6',
    'bin/codex-code-mode-host.exe': 'a8da671dfabef13a370e0a06864586f52932b477f462afa3f0c51ae30d9207a2',
    'bin/codex-exec-server.exe': 'a09038191aa34a9b2280e65ba90a82f29fc4e7257636b1143d71a4cb00103495',
    'codex-package.json': 'a44eb5932b9b4a278a0f524a5e6faf271b780265db640925e894579034ba7865',
    'codex-path/rg.exe': '14231169855ec5205cf5a1b6f1db358ff4aed4247c86b69ce8aae647c77f6680',
    'codex-resources/codex-command-runner.exe': 'dbb8ac49c4b36d2de9977710b3400523f2336b7b326bcab7602108e88e0a69b0',
    'codex-resources/codex-windows-sandbox-setup.exe': '885a1eda0640970c5aa03be7f3c540dc6f406915f7df2e7fee4b6a5e0fe30765',
  },
  nodeVersion: '24.22.1',
  nodeArchiveSha256: 'd2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5',
} as const;

export const LINUX_CODEX_RUNTIME = {
  executable: 'bin/codex-app-server',
  archiveUrl: 'https://github.com/openai/codex/releases/download/rust-v0.169.0/codex-app-server-package-x86_64-unknown-linux-musl.tar.gz',
  archiveSha256: '91c08d7d795342f934ba90ae105427be54effcd9844ae63e2ec0cca2484ba452',
  executableSha256: 'be98f53eea954e56fb3362b45fa41b00ea9c00072d2bfd06206ea287f6d4e464',
  requiredFiles: {
    'bin/codex-app-server': 'be98f53eea954e56fb3362b45fa41b00ea9c00072d2bfd06206ea287f6d4e464',
    'bin/codex-code-mode-host': '3312f0aa60620493e43a7882820e85ddb33b80e3f5456e00e18fdbd28487a99c',
    'bin/codex-exec-server': 'a54076bd291228783df3e74147218327a9b04e896b8cb999332a9dab92d72be6',
    'codex-package.json': '49d153b5aed4e83e25b84f62eee1698be375023619ffbf3cf3a41edb957528b5',
    'codex-path/rg': 'e62198eb19b136b88c330af83647b5a962cb99b6b1f066758568f12de1974849',
    'codex-resources/bwrap': '15fd5f2673d2e1c2f80e34e5108462fd014f5e8bbc7b0731f1ab23d1ff1ac140',
  },
} as const;
