# The environment variables an OpenClaw config reads, as OpenClaw resolves them
# (docs/gateway/config-secrets-env.md): `${VAR}` substitutions without a `:-`
# fallback (not the `$${VAR}` escape), whole-string `$VAR` secret shorthands, env
# SecretRefs ({source = "env"; id}) and the legacy `secretref-env:` and `__env__:`
# markers. Sorted and unique: `envReferencesOf (lib.importJSON ./openclaw.json)`.
lib: let
  inString = s: let
    shorthand = builtins.match "\\$([A-Z][A-Z0-9_]{0,127})" s;
    marker = builtins.match "(secretref-env:|__env__:)([A-Z][A-Z0-9_]{0,127})" s;
    substitutions =
      builtins.filter (m: builtins.isList m && builtins.elemAt m 0 == "" && builtins.elemAt m 2 == null)
      (builtins.split "(\\$?)\\$\\{([A-Z_][A-Z0-9_]*)(:-[^}]*)?}" s);
  in
    lib.optionals (shorthand != null) shorthand
    ++ lib.optional (marker != null) (builtins.elemAt marker 1)
    ++ map (m: builtins.elemAt m 1) substitutions;
  walk = value:
    if builtins.isString value
    then inString value
    else if builtins.isList value
    then lib.concatMap walk value
    else if builtins.isAttrs value
    then
      lib.optional ((value.source or null) == "env" && builtins.isString (value.id or null)) value.id
      ++ lib.concatMap walk (builtins.attrValues value)
    else [];
in
  value: lib.sort lib.lessThan (lib.unique (walk value))
