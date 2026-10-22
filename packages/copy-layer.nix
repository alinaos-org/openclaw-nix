# The copy discipline of every layer over a finished gateway tree (the hotfix
# and customize layers, the workstation module's plugin graft): copy the tree,
# then make the copy self-contained. A copy that still links or names the tree
# it came from keeps that tree in its closure, a second 2.7 GiB copy per layer,
# and code can load from it: until 2026-10-22 prod's fenced gateway held three
# trees (the source build through node_modules/.bin/codex and the toolchain
# links, the un-hotfixed customize layer through the grafted Fusion plugin's
# `openclaw` peer).
#
# Each layer also sets `disallowedRequisites = pathsOf (treesOf gateway)`, so
# Nix fails the build when anything in the finished tree, a symlink, a text or
# binary file or another store path it references, still leads to an earlier
# tree.
{lib}: rec {
  # The gateway trees a layer over `gateway` comes from, `gateway` first and
  # the source build last (passthru.copyLayerOf).
  treesOf = gateway:
    [gateway]
    ++ lib.optionals (gateway ? passthru.copyLayerOf) (treesOf gateway.passthru.copyLayerOf);

  # Trees as plain store paths for `disallowedRequisites`, not build inputs:
  # an output can only reference paths among its build's inputs, and as
  # inputs they would have to be built or fetched first.
  pathsOf = map (tree: builtins.unsafeDiscardStringContext (toString tree));

  # Shell: copy `gateway` to $out and repoint what pointed into it. A symlink
  # into it becomes a relative link to the same path in the copy; a text file
  # that names it names $out instead. A binary that names it fails the build.
  copyTree = gateway: ''
    cp -a ${gateway}/. "$out"
    chmod -R u+w "$out"
    copied_from=${gateway}
    while IFS= read -r -d "" link; do
      target=$(readlink "$link")
      ln -sfn "$(realpath -sm --relative-to="$(dirname "$link")" "$out''${target#"$copied_from"}")" "$link"
      if [ ! -e "$link" ]; then
        echo "copy layer: $link (was $target) does not resolve in the copy" >&2
        exit 1
      fi
    done < <(find "$out" -type l \( -lname "$copied_from" -o -lname "$copied_from/*" \) -print0)
    while IFS= read -r -d "" file; do
      if ! grep -qI . "$file"; then
        echo "copy layer: binary file $file names $copied_from" >&2
        exit 1
      fi
      sed -i "s|$copied_from|$out|g" "$file"
    done < <(grep -rlZF -- "$copied_from" "$out")
  '';

  # Shell: symlinks under `dirs` (shell words, such as ''"$graft_root"'') that
  # lead into an OpenClaw tree (`lib/openclaw` of any store path) lead to the
  # same path in this one, relatively, as the bundled plugins' own
  # node_modules/openclaw do. For plugins grafted into the tree, whose
  # `openclaw` peer was built against another gateway.
  adoptOpenClawLinks = dirs: ''
    while IFS= read -r -d "" link; do
      target=$(readlink "$link")
      ln -sfn "$(realpath -sm --relative-to="$(dirname "$link")" "$out/lib/openclaw''${target#${builtins.storeDir}/*/lib/openclaw}")" "$link"
      if [ ! -e "$link" ]; then
        echo "copy layer: $link (was $target) does not resolve in this tree" >&2
        exit 1
      fi
    done < <(find ${dirs} -type l \
      \( -lname '${builtins.storeDir}/*/lib/openclaw' -o -lname '${builtins.storeDir}/*/lib/openclaw/*' \) -print0)
  '';
}
