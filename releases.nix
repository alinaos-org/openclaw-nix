# Pinned OpenClaw releases. Each entry is the exact commit peeled from the
# release tag (it must equal the release notes' "release SHA"), never a branch
# or tag. scripts/new-release.py writes new entries; pnpmDepsHash is per system
# because the dependency store is fetched for the host platform only.
{
  "2026.10.4" = {
    rev = "383c124cc32ffee3f8e56f549b88da94d269a4af";
    sourceHash = "sha256-g6lSQUZsyW4yWpIn9SrH8fDvzhFXcU4W2XUxxwd6EFw=";
    pnpmDepsHash.x86_64-linux = "sha256-IN34WeTkOvWROLa73tTCzSRt1QqAsIT3FgNzSB8URBQ=";
    buildTimestamp = "2026-10-15T07:58:34Z";
    pnpmBootstrapVersion = "12.5.1";
    tsdownHeapMb = "6144";
  };

  "2026.10.3" = {
    rev = "59cb44796b0f1f0daa0e37af8b1495abb45d9bc1";
    sourceHash = "sha256-eNcTYmHZyPiVKOsqdafGBJ//XFQXfsS+2sRsIJ733/o=";
    pnpmDepsHash.x86_64-linux = "sha256-IN34WeTkOvWROLa73tTCzSRt1QqAsIT3FgNzSB8URBQ=";
    buildTimestamp = "2026-10-13T07:22:49Z";
    pnpmBootstrapVersion = "12.5.1";
    tsdownHeapMb = "6144";
  };

  "2026.10.2" = {
    rev = "b8952d477f0c932d8ddc6da5c89cab5a169b6ff1";
    sourceHash = "sha256-zJ5lnF5HmLfhIrbAYTYatwuTDpDxEP92YGK1A3Y6Ki8=";
    pnpmDepsHash.x86_64-linux = "sha256-IN34WeTkOvWROLa73tTCzSRt1QqAsIT3FgNzSB8URBQ=";
    buildTimestamp = "2026-10-11T22:23:15Z";
    pnpmBootstrapVersion = "12.5.1";
    tsdownHeapMb = "6144";
  };

  "2026.10.1" = {
    rev = "e178c39e9aae3fa440735217f9aef9574f286677";
    sourceHash = "sha256-KWbh0iUzav08tohNFh76T2vIALfd5un5w3RHDCfe8yw=";
    pnpmDepsHash.x86_64-linux = "sha256-IN34WeTkOvWROLa73tTCzSRt1QqAsIT3FgNzSB8URBQ=";
    buildTimestamp = "2026-10-10T17:45:18Z";
    pnpmBootstrapVersion = "12.5.1";
    tsdownHeapMb = "6144";
  };
}
