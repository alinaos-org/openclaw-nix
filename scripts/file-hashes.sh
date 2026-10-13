#!/usr/bin/env bash
# Per-file SHA-256 list of a build output, one line per file and per symlink, sorted:
#
#   scripts/file-hashes.sh <store-path> > hashes.txt
#
# Two builds of the same store path with different NAR hashes differ in some file; diff
# their lists to find which. The reproducibility workflow publishes the cached build's
# list, so a host that compiled its own can compare without downloading the NAR.
set -euo pipefail
root=${1:?usage: file-hashes.sh <store-path>}
cd "$root"
export LC_ALL=C
find . -type f -print0 | sort -z | xargs -0 -r sha256sum
find . -type l -printf 'link %p -> %l\n' | sort
