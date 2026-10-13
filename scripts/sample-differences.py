"""Copy both versions of the smallest files that differ between two builds.

    python3 -I scripts/sample-differences.py <cached> <rebuilt> <cached.txt> <rebuilt.txt> <out> [limit]

The lists are scripts/file-hashes.sh output. Files are paired by path, with a Vite-style
content hash in the name ignored (about-page-CpeRW8yD.js and about-page-B8DUMyHE.js are
one pair), so a chunk whose content changed, and therefore its name, is still compared.
Pairs that differ beyond the names of the chunks they import are the causes; they are
listed in causes.txt and copied first.
"""

import gzip
import re
import shutil
import sys
from pathlib import Path

cached_root, rebuilt_root, cached_list, rebuilt_list, out = sys.argv[1:6]
limit = int(sys.argv[6]) if len(sys.argv) > 6 else 40
HASHED = re.compile(r"-[A-Za-z0-9_-]{8}(?=\.)")


def entries(listing):
    files = {}
    for line in Path(listing).read_text().splitlines():
        if line.startswith("link "):
            continue
        digest, path = line.split("  ", 1)
        files.setdefault(HASHED.sub("-*", path), []).append((path, digest))
    return files


cached, rebuilt = entries(cached_list), entries(rebuilt_list)
pairs = []
for key in cached.keys() & rebuilt.keys():
    # Only unambiguous pairs: one file on each side under this key.
    if len(cached[key]) != 1 or len(rebuilt[key]) != 1:
        continue
    (a, digest_a), (b, digest_b) = cached[key][0], rebuilt[key][0]
    if digest_a != digest_b:
        pairs.append((Path(cached_root, a).stat().st_size, a, b))

# A content-hashed chunk changes name whenever a chunk it imports does, so most
# differing pairs differ only in those names. The pairs that still differ with the
# names normalized are the causes: list them all and copy them first.
NAME_REF = re.compile(rb"-[A-Za-z0-9_-]{8}(?=\.(?:js|css|map|json)\b)")


def normalized(path):
    data = Path(path).read_bytes()
    if path.endswith(".gz"):
        data = gzip.decompress(data)
    return NAME_REF.sub(b"-HASH", data)


causes = [(size, a, b) for size, a, b in pairs
          if not a.endswith(".br") and normalized(str(Path(cached_root, a))) != normalized(str(Path(rebuilt_root, b)))]
causes.sort()
Path(out).mkdir(parents=True, exist_ok=True)
Path(out, "causes.txt").write_text("".join(f"{size}\t{a}\t{b}\n" for size, a, b in causes))
print(f"{len(causes)} pairs differ beyond the names of the chunks they import (causes.txt)")
pairs.sort()
picked = causes[:limit] + [p for p in pairs if p not in causes][:max(0, limit - len(causes))]
for _, a, b in picked:
    for root, path, side in ((cached_root, a, "cached"), (rebuilt_root, b, "rebuilt")):
        target = Path(out, side, path)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(Path(root, path), target)
print(f"{len(pairs)} differing pairs; copied {len(picked)} to {out}, causes first")
