"""Copy both versions of the smallest files that differ between two builds.

    python3 -I scripts/sample-differences.py <cached> <rebuilt> <cached.txt> <rebuilt.txt> <out> [limit]

The lists are scripts/file-hashes.sh output. Files are paired by path, with a Vite-style
content hash in the name ignored (about-page-CpeRW8yD.js and about-page-B8DUMyHE.js are
one pair), so a chunk whose content changed, and therefore its name, is still compared.
"""

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

pairs.sort()
for _, a, b in pairs[:limit]:
    for root, path, side in ((cached_root, a, "cached"), (rebuilt_root, b, "rebuilt")):
        target = Path(out, side, path)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(Path(root, path), target)
print(f"{len(pairs)} differing pairs; copied the {min(limit, len(pairs))} smallest to {out}")
