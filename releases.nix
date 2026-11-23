# Pinned OpenClaw releases. Each entry is the exact commit peeled from the
# release tag (it must equal the release notes' "release SHA"), never a branch
# or tag. scripts/new-release.py writes new entries; pnpmDepsHash is per system
# because the dependency store is fetched for the host platform only;
# desktopDebHash is the release's amd64 desktop .deb (packages/desktop).
# `sessionIconPicker = false;` builds a release with OpenClaw's own session icon
# picker: new-release.py sets it when openclaw-nix's picker patch does not apply,
# and the re-port deletes it (README, "Session icons").
{
  "2026.11.7" = {
    rev = "e31bbf056de321127988ec5c1a36ff1b59297de0";
    sourceHash = "sha256-mNApehyzd0o5SELkvOyFPsaPD85Bvu4JPin3mAWgvnI=";
    pnpmDepsHash.x86_64-linux = "sha256-eIOpuKvAmz94Lh5DL74EAFuom6S3x9Zu/7sIXJrkX/Y=";
    desktopDebHash.x86_64-linux = "sha256-x9QQNKDbHCCTaWzBGQ823u+NEaHoxfxwC2qvAg6X0Ig=";
    buildTimestamp = "2026-11-22T14:04:12Z";
    pnpmBootstrapVersion = "12.15.0";
    tsdownHeapMb = "6144";
    # The macOS fs-safe natives the worker bundle embeds (packages/gateway/default.nix).
    workerNativeAssets = {
      darwin-arm64 = {
        version = "0.27.1";
        integrity = "sha512-RXheLSPD8K0IiJ4p6KW8JVlrLd148OM84Z6wDerEmiF3/RbiiBUerNJ+LIzjyxDesZoCQIr8okq6zLdjSZkvdg==";
      };
      darwin-x64 = {
        version = "0.27.1";
        integrity = "sha512-2CfUUGJc4dwaTuvo4xiKq5zbF9p6p6Cp+zS+M0hTg2E8RLPH/i2+CtF1MOeeMY6q/7FlpS4AOBcf4NNQmLCZFA==";
      };
    };
    # The session icon picker patch does not apply to this release: it builds
    # with OpenClaw's own picker until the patch is re-ported (README,
    # "Session icons"). The re-port deletes these lines.
    sessionIconPicker = false;
  };

  "2026.11.6" = {
    rev = "06afb10d3272cc9deaf38ca6a3b7b839d5935638";
    sourceHash = "sha256-RxT474ub1nndQleEsYR/qd8fXKw8ci7/mihBHlJrWmQ=";
    pnpmDepsHash.x86_64-linux = "sha256-PmhIjidnBMy8F/M8awB2lJ9NlViYhZkyTZILXkH9vGs=";
    desktopDebHash.x86_64-linux = "sha256-qbGgcARsDYa75bm+kRaQwZ0hWLZ3/OuzMOBkFqUSOFw=";
    buildTimestamp = "2026-11-19T08:35:07Z";
    pnpmBootstrapVersion = "12.15.0";
    tsdownHeapMb = "6144";
    # The macOS fs-safe natives the worker bundle embeds (packages/gateway/default.nix).
    workerNativeAssets = {
      darwin-arm64 = {
        version = "0.26.13";
        integrity = "sha512-R3mXijsyLrFVRiLjNlpEcmN9SZWMVd7keZWtVngGp19C56lHm/ye5/UJV2rICe5xsuxXM6q0iGKXkcQdUc9uKA==";
      };
      darwin-x64 = {
        version = "0.26.13";
        integrity = "sha512-s0ZKDbVIQCjUpgwxA3RMmt7UTyGQcWmkicxC7DdOq/hqLwzCRx74nb0zDrbuBHZCW9y6lF6PeqPfppPtwXqjDg==";
      };
    };
    # The session icon picker patch does not apply to this release: it builds
    # with OpenClaw's own picker until the patch is re-ported (README,
    # "Session icons"). The re-port deletes these lines.
    sessionIconPicker = false;
  };

  "2026.11.5" = {
    rev = "e13cf15ece9bbd969b7362927c315362c90c97ff";
    sourceHash = "sha256-QM9QQndWpExuDos12tU71/LFGRNEOZM82uihPFnPlX8=";
    pnpmDepsHash.x86_64-linux = "sha256-gyRqH+IE2SrSQddiXdgpMkAHJNiGEFJOol1pK1R+Los=";
    desktopDebHash.x86_64-linux = "sha256-SJNAPx41h5M0hD6jVULl7tNYEhPG7p87XkwkbCq7Fio=";
    buildTimestamp = "2026-11-17T03:12:30Z";
    pnpmBootstrapVersion = "12.15.0";
    tsdownHeapMb = "6144";
    # The macOS fs-safe natives the worker bundle embeds (packages/gateway/default.nix).
    workerNativeAssets = {
      darwin-arm64 = {
        version = "0.26.13";
        integrity = "sha512-R3mXijsyLrFVRiLjNlpEcmN9SZWMVd7keZWtVngGp19C56lHm/ye5/UJV2rICe5xsuxXM6q0iGKXkcQdUc9uKA==";
      };
      darwin-x64 = {
        version = "0.26.13";
        integrity = "sha512-s0ZKDbVIQCjUpgwxA3RMmt7UTyGQcWmkicxC7DdOq/hqLwzCRx74nb0zDrbuBHZCW9y6lF6PeqPfppPtwXqjDg==";
      };
    };
    # The session icon picker patch does not apply to this release: it builds
    # with OpenClaw's own picker until the patch is re-ported (README,
    # "Session icons"). The re-port deletes these lines.
    sessionIconPicker = false;
  };

  "2026.11.4" = {
    rev = "d843d6af39a42cd3c30084edbeabeece732fd93a";
    sourceHash = "sha256-R3q8kRgXm7idp0RG7lGJBSzrWyvYF+nxSBxpmGD3pg8=";
    pnpmDepsHash.x86_64-linux = "sha256-Usx8TEP8Ewkcz85jwSL1rC5vfNNWMyR5zyx5MeYftmo=";
    desktopDebHash.x86_64-linux = "sha256-/UN+E19y3HJ4WJvsX/Py+jBVt0Vq4gQszVIbZ/Ps+9E=";
    buildTimestamp = "2026-11-15T20:38:57Z";
    pnpmBootstrapVersion = "12.15.0";
    tsdownHeapMb = "6144";
  };

  "2026.11.3" = {
    rev = "847611dcaa3bf0e2783335f961dd1fd0580e4d9f";
    sourceHash = "sha256-wBHvOpO6Si9ZkymTI5VCSJrMMnJgjpyXrMY7MATP+Js=";
    pnpmDepsHash.x86_64-linux = "sha256-iFrzZl/vcqRYAj+8isNVcoW2c84SRuE4QlAE+oHmDIc=";
    buildTimestamp = "2026-11-10T09:44:17Z";
    pnpmBootstrapVersion = "12.15.0";
    tsdownHeapMb = "6144";
  };

  "2026.11.2" = {
    rev = "b556fdf457b026574bf0f1e7b4914b15f3f179ce";
    sourceHash = "sha256-ubwo17mNougwqxDo5vpylmhy1b+KYwUXL30wjH2Cjog=";
    pnpmDepsHash.x86_64-linux = "sha256-iFrzZl/vcqRYAj+8isNVcoW2c84SRuE4QlAE+oHmDIc=";
    desktopDebHash.x86_64-linux = "sha256-GQ2JkOeMrzbvAwiaQ0d4l/dZMvUyh8jNFKj5zdntpcs=";
    buildTimestamp = "2026-11-07T10:02:22Z";
    pnpmBootstrapVersion = "12.15.0";
    tsdownHeapMb = "6144";
  };

  "2026.11.1" = {
    rev = "4ffdd2047d192dd65554de3c8c46c0e0197c6e2a";
    sourceHash = "sha256-/iCQNnuOBXp4/LtAlsZZJ5d4Qxwfc61LlCdUcVvuSYA=";
    pnpmDepsHash.x86_64-linux = "sha256-iFrzZl/vcqRYAj+8isNVcoW2c84SRuE4QlAE+oHmDIc=";
    desktopDebHash.x86_64-linux = "sha256-7AajW1tRTjGbPHY9HmBZg171R0Cyk7/XOxmisfwvDBY=";
    buildTimestamp = "2026-11-05T01:14:32Z";
    pnpmBootstrapVersion = "12.15.0";
    tsdownHeapMb = "6144";
  };

  "2026.10.10" = {
    rev = "7dc3350cb9f08fcf9a0af5c4845a20d5b2f1a8be";
    sourceHash = "sha256-S4rfwLtZv9tcz0bfWKKykYRvC+DfxXQnSnP+kUy3J8k=";
    pnpmDepsHash.x86_64-linux = "sha256-iFrzZl/vcqRYAj+8isNVcoW2c84SRuE4QlAE+oHmDIc=";
    desktopDebHash.x86_64-linux = "sha256-MNazQYP2okkSN2WtHD6YFejwcS2h0k5LZXQBZq+C8BM=";
    buildTimestamp = "2026-11-02T19:28:02Z";
    pnpmBootstrapVersion = "12.15.0";
    tsdownHeapMb = "6144";
  };

  "2026.10.9" = {
    rev = "8b18b5578f66eab1501cba4cef2310d88bfb9a41";
    sourceHash = "sha256-JmP3YwDwyLScNkeSUAJfmaWlhzj/ctsERXzBgYtqGzw=";
    pnpmDepsHash.x86_64-linux = "sha256-+Dzk7bCh6av0rX77plzSiOx1i3tk0ZhB7ckiaLFNhBQ=";
    desktopDebHash.x86_64-linux = "sha256-8qmqmEh5WXfRy0WEoXXMl+58nfeJZSQcoEYwBRBhjyQ=";
    buildTimestamp = "2026-10-29T11:01:13Z";
    pnpmBootstrapVersion = "12.15.0";
    tsdownHeapMb = "6144";
  };

  "2026.10.8" = {
    rev = "dc2523e5a5c7a309517fd7fa834add938231d526";
    sourceHash = "sha256-YdvJPrXEumzZRI+0/9b73yBnXNP3zD4UvML9vw1ezL4=";
    pnpmDepsHash.x86_64-linux = "sha256-rCj9b7iwyr82vWuFJFs8KhEt22FlAynooMlTSYLDoyU=";
    desktopDebHash.x86_64-linux = "sha256-5pehxaswLO8EBFg0AMsfqQDgWHKBWZ8IXhE/pM6OhgE=";
    buildTimestamp = "2026-10-27T04:14:13Z";
    pnpmBootstrapVersion = "12.15.0";
    tsdownHeapMb = "6144";
  };

  "2026.10.7" = {
    rev = "157d8c2bc3ea2fa183afdc11088e69690bf8e64e";
    sourceHash = "sha256-J/jIhSX0fRmUw0cv/2i2YXUOBw4yimIndp9LO6ueq2U=";
    pnpmDepsHash.x86_64-linux = "sha256-rCj9b7iwyr82vWuFJFs8KhEt22FlAynooMlTSYLDoyU=";
    desktopDebHash.x86_64-linux = "sha256-IqOd6hUs1l3ilb2r1Wz2Tb4tOaT0CWXu0L4+mi/TxvA=";
    buildTimestamp = "2026-10-24T02:13:54Z";
    pnpmBootstrapVersion = "12.15.0";
    tsdownHeapMb = "6144";
  };

  "2026.10.6" = {
    rev = "fe06181dc5ecc01cf8904abbfc26925925efefbc";
    sourceHash = "sha256-bobJYn46LJzAmo9Naz6W3nla1rsVGPiptYpHxTegneg=";
    pnpmDepsHash.x86_64-linux = "sha256-X7ymog1YJp8RMU62ZvRXW9F1/ewtzP5ytzXvC84fKpQ=";
    buildTimestamp = "2026-10-22T08:45:01Z";
    pnpmBootstrapVersion = "12.15.0";
    tsdownHeapMb = "6144";
  };

  "2026.10.5" = {
    rev = "1b58cb9a1b4f4353e1add63c8506db4d890962e8";
    sourceHash = "sha256-+Bqk2u4hDiyqK1upJ96tc6Zu5dDNjIl/yhKtMB1XUZw=";
    pnpmDepsHash.x86_64-linux = "sha256-X7ymog1YJp8RMU62ZvRXW9F1/ewtzP5ytzXvC84fKpQ=";
    buildTimestamp = "2026-10-18T17:13:45Z";
    pnpmBootstrapVersion = "12.9.0";
    tsdownHeapMb = "6144";
  };

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
