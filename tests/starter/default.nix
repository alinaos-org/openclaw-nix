# checks.starter: a teammate's laptop as init generates it from the starter template
# boots, sops-nix decrypts its secrets for that user alone, and its gateway runs on
# them. A test age key stands in for the host's SSH key and the person's own key.
{
  pkgs,
  self,
  nix-openclaw,
  sops-nix,
  init,
}: let
  generated =
    pkgs.runCommand "openclaw-starter-generated" {
      outputs = ["out" "key"];
      nativeBuildInputs = [pkgs.age];
    } ''
      export HOME=$TMPDIR
      age-keygen -o "$TMPDIR/key.txt" 2> /dev/null
      echo 'sk-starter-provider' | ${init}/bin/openclaw-nix-init "$TMPDIR/laptop" --non-interactive \
        --user alice --full-name 'Alice Example' --hostname laptop --time-zone UTC \
        --provider openai --auth api-key --state-version 25.11 --openclaw-nix-ref test \
        --hardware-config ${pkgs.writeText "hardware-configuration.nix" "{}"} \
        --host-age-recipient "$(age-keygen -y "$TMPDIR/key.txt")" --age-key-file "$TMPDIR/key.txt" \
        --provider-key-stdin --no-git
      cp -r "$TMPDIR/laptop" "$out"
      install -Dm444 "$TMPDIR/key.txt" "$key/key.txt"
    '';
in
  pkgs.testers.runNixOSTest {
    name = "openclaw-starter";
    # The workstation module adds its package-set overlays, as on a real host.
    node.pkgsReadOnly = false;
    nodes.machine = {
      lib,
      pkgs,
      ...
    }: {
      imports = [
        nix-openclaw.inputs.home-manager.nixosModules.home-manager
        sops-nix.nixosModules.sops
        self.nixosModules.workstation
        "${generated}/host.nix"
        "${generated}/openclaw.nix"
      ];
      # A VM boots without the laptop's boot loader and NetworkManager.
      boot.loader.systemd-boot.enable = lib.mkForce false;
      boot.loader.efi.canTouchEfiVariables = lib.mkForce false;
      networking.networkmanager.enable = lib.mkForce false;
      # sops-nix refuses a key in the store: the test key goes to /var/lib first.
      sops.age.sshKeyPaths = lib.mkForce [];
      sops.age.keyFile = "/var/lib/sops-test/key.txt";
      system.activationScripts.sopsTestKey.text = ''
        install -D -m 400 ${generated.key}/key.txt /var/lib/sops-test/key.txt
      '';
      system.activationScripts.setupSecrets.deps = ["sopsTestKey"];
      virtualisation.memorySize = 4096;
      virtualisation.cores = 2;
      environment.systemPackages = [pkgs.curl pkgs.jq];
    };
    testScript = {nodes, ...}: ''
      import json

      state = "/home/alice/.openclaw-main"
      env = "/run/secrets/rendered/openclaw.env"
      as_alice = "runuser -u alice -- env HOME=/home/alice XDG_RUNTIME_DIR=/run/user/1000 "
      required = json.loads('${builtins.toJSON nodes.machine.services.openclaw.workstation.instances.main.requiredEnvironment}')

      machine.wait_for_unit("multi-user.target")
      machine.wait_for_unit("openclaw-gateway-main.service", "alice")
      machine.wait_until_succeeds("curl -sf http://127.0.0.1:18789/readyz", timeout=600)

      with subtest("sops-nix renders the gateway's env file, readable by alice alone"):
          machine.succeed(f"test \"$(stat -c '%U %a' {env})\" = 'alice 400'")
          machine.succeed(f"grep -qx OPENAI_API_KEY=sk-starter-provider {env}")
          token = machine.succeed(f"sed -n 's/^OPENCLAW_GATEWAY_TOKEN=//p' {env}").strip()
          assert len(token) == 64, len(token)

      with subtest("the secrets stay out of the configs"):
          for secret in [token, "sk-starter-provider"]:
              machine.fail(f"grep -qF {secret} {state}/openclaw.json {state}/openclaw-runtime.json")

      with subtest("the gateway takes the token from secrets/openclaw.yaml, and no other"):
          call = (
              "runuser -u alice -- env HOME=/home/alice "
              f"OPENCLAW_STATE_DIR={state} OPENCLAW_CONFIG_PATH={state}/openclaw-runtime.json "
              "OPENCLAW_GATEWAY_TOKEN={} /etc/profiles/per-user/alice/bin/openclaw "
              "gateway call health --json --timeout 30000"
          )
          print(machine.succeed(call.format(token)))
          machine.fail(call.format("not-the-token"))

      with subtest("requiredEnvironment: the config's token reference and the provider key"):
          assert required == ["OPENAI_API_KEY", "OPENCLAW_GATEWAY_TOKEN"], required
          machine.succeed(f"test \"$(grep -c = {env})\" = {len(required)}")

      with subtest("the gateway process gets the provider key (unsetOpenAIApiKey off for it)"):
          pid = machine.succeed(as_alice + "systemctl --user show -p MainPID --value openclaw-gateway-main.service").strip()
          machine.succeed(f"tr '\\0' '\\n' < /proc/{pid}/environ | grep -qx OPENAI_API_KEY=sk-starter-provider")

      with subtest("openclaw-doctor passes, and names a missing variable"):
          doctor = as_alice + "/etc/profiles/per-user/alice/bin/openclaw-doctor"
          out = machine.succeed(doctor)
          print(out)
          for check in ["environment", "gateway", "secrets"]:
              assert f"ok   main: {check}" in out, out
          # The key is found; the VM's CLI cannot load Codex's runtime: a warning.
          assert "warn main: models: signed in; the CLI cannot load the runtime for openai via codex" in out, out
          for piece in ["sk-starter-provider", "sk-start", "provider", token, token[:8], token[-8:]]:
              assert piece not in out, (piece, out)
          machine.succeed(f"cp -p {env} /tmp/openclaw.env.saved && sed -i '/^OPENAI_API_KEY=/d' {env}")
          status, out = machine.execute(doctor)
          print(out)
          assert status == 1 and "FAIL main: environment: OPENAI_API_KEY not set" in out, out
          machine.succeed(f"cp -p /tmp/openclaw.env.saved {env}")

      with subtest("the template's model and workspace reach the runtime config"):
          machine.succeed(
              f"jq -e '.agents.defaults.model.primary == \"openai/gpt-6-astra\" "
              f"and .agents.defaults.workspace == \"{state}/workspace\"' {state}/openclaw-runtime.json"
          )
    '';
  }
