// session-icons Control UI entry: a searchable library of colour session icons,
// opened from the session menu (Icon library…).
//
// The built-in icon picker has no extension point, so this is a session action
// with its own dialog. A choice is saved exactly like a custom icon from the
// built-in picker: a self-contained SVG data URL in the session's icon field,
// through the gateway's own sessions.patch. Every client renders it, with or
// without this plugin.
//
// Plain browser module with no imports: the gateway serves this file as-is.

const PLUGIN_ID = "session-icons";
const ACTION_ID = "icon-library";
const SVG_DATA_URL_PREFIX = "data:image/svg+xml,";

// The saved value of each icon. These strings are what sessions store, so they
// must stay byte-identical: a different encoding would stop matching the icons
// sessions already have.
const colourSource = (id) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">${ARTWORK[id]}</svg>`;
// The first library build (2026-10-12) saved one-colour outlines; they still
// count as that icon when the library marks the current choice.
const outlineSource = (path) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#7a92c2" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`;

let catalogCache;
/** Every library icon with its saved value. */
export function catalog() {
  catalogCache ??= DEFINITIONS.map((icon) => ({
    ...icon,
    value: `${SVG_DATA_URL_PREFIX}${encodeURIComponent(colourSource(icon.id))}`,
    legacyValue: `${SVG_DATA_URL_PREFIX}${encodeURIComponent(outlineSource(icon.path))}`,
  }));
  return catalogCache;
}

/** Icons whose label, group or keywords contain every search term. */
export function searchIcons(query) {
  const terms = String(query ?? "").trim().toLowerCase().split(/\s+/u).filter(Boolean);
  return catalog().filter((icon) => {
    const text = `${icon.label} ${icon.group} ${icon.keywords}`.toLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

export function isSelected(current, icon) {
  return current === icon.value || current === icon.legacyValue;
}

/** The sessions.patch parameters that give a session this icon. */
export function iconPatch(session, icon) {
  return {key: session.sessionKey, ...(session.agentId ? {agentId: session.agentId} : {}), icon: icon.value};
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function openLibrary(host, session) {
  let current = session.icon ?? null;
  let busy = false;
  let closed = false;

  const content = el("div", "session-icons");
  const search = el("input", "session-icons__search");
  search.type = "search";
  search.placeholder = "Search icons…";
  search.setAttribute("aria-label", "Search work and interest icons");
  const results = el("div", "session-icons__results");
  const footer = el("div", "session-icons__footer");
  const count = el("span", "session-icons__count");
  count.setAttribute("role", "status");
  const error = el("span", "session-icons__error");
  error.setAttribute("role", "alert");
  footer.append(count, error);
  content.append(search, results, footer);

  const container = el("div");
  document.body.append(container);
  const dialog = host.components.mountDialog(container, {
    label: "Icon library",
    description: "Choose an icon for this session.",
    content,
    onCancel: () => {
      if (busy) return false;
      close();
    },
  });

  function close() {
    if (closed) return;
    closed = true;
    dialog.dispose();
    container.remove();
  }
  host.signal.addEventListener("abort", close, {once: true});

  const choices = () => Array.from(results.querySelectorAll("button.session-icons__choice"));
  const columns = (button) => {
    const template = getComputedStyle(button.parentElement).gridTemplateColumns;
    return Math.max(1, template.split(" ").filter(Boolean).length);
  };
  function focusChoice(button) {
    for (const choice of choices()) choice.tabIndex = choice === button ? 0 : -1;
    button.focus();
  }

  async function choose(icon) {
    if (busy) return;
    busy = true;
    error.textContent = "";
    for (const choice of choices()) choice.disabled = true;
    try {
      await host.request("sessions.patch", iconPatch(session, icon));
      current = icon.value;
      close();
    } catch (failure) {
      busy = false;
      error.textContent = `Could not save the icon: ${errorText(failure)}`;
      render();
    }
  }

  function render() {
    const matches = searchIcons(search.value);
    const selected = matches.find((icon) => isSelected(current, icon)) ?? matches[0];
    results.replaceChildren();
    for (const group of [...new Set(matches.map((icon) => icon.group))]) {
      results.append(el("div", "session-icons__group", group));
      const grid = el("div", "session-icons__grid");
      grid.setAttribute("role", "group");
      grid.setAttribute("aria-label", group);
      for (const icon of matches.filter((match) => match.group === group)) {
        const button = el("button", "session-icons__choice");
        button.type = "button";
        button.title = icon.label;
        button.setAttribute("aria-label", icon.label);
        button.setAttribute("aria-pressed", String(isSelected(current, icon)));
        button.tabIndex = icon === selected ? 0 : -1;
        button.disabled = busy || !host.connection.canWrite;
        const image = el("img");
        image.src = icon.value;
        image.alt = "";
        image.setAttribute("aria-hidden", "true");
        button.append(image);
        button.addEventListener("click", () => void choose(icon));
        grid.append(button);
      }
      results.append(grid);
    }
    if (matches.length === 0) {
      results.append(el("p", "session-icons__empty", "No matching icons. Try “flight”, “AI”, or “surf”."));
    }
    count.textContent = `${matches.length} icons`;
  }

  search.addEventListener("input", render);
  search.addEventListener("keydown", (event) => {
    if (event.key === "Enter") event.preventDefault();
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const first = choices().find((choice) => choice.tabIndex === 0) ?? choices()[0];
      if (first) focusChoice(first);
    }
  });
  results.addEventListener("keydown", (event) => {
    const all = choices();
    const index = all.indexOf(event.target);
    if (index < 0) return;
    const step = {ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns(event.target), ArrowDown: columns(event.target)}[event.key];
    let next;
    if (step !== undefined) next = all[index + step];
    else if (event.key === "Home") next = all[0];
    else if (event.key === "End") next = all[all.length - 1];
    else return;
    event.preventDefault();
    if (next) focusChoice(next);
    else if (event.key === "ArrowUp") search.focus();
  });

  render();
  // The host mounts the dialog asynchronously; focus the search once it is shown.
  let attempts = 0;
  const focusSearch = () => {
    if (closed) return;
    if (search.isConnected) search.focus();
    else if (attempts++ < 60) requestAnimationFrame(focusSearch);
  };
  requestAnimationFrame(focusSearch);
}

export default {
  id: PLUGIN_ID,
  activate(host) {
    return host.ui.registerAction({
      id: ACTION_ID,
      label: "Icon library…",
      placement: "session",
      resolve: () => ({disabled: !host.connection.canWrite}),
      run: ({sessionKey, agentId, session}) => {
        openLibrary(host, {sessionKey, agentId, icon: session?.icon ?? null});
      },
    });
  },
};

// Catalog: 72 icons in nine groups. path is the one-colour outline the first
// library build saved; ARTWORK holds the original multicolour 24px
// illustrations (no fonts, external assets or theme tint).
const DEFINITIONS = [
  {id: "aircraft", label: "Aircraft", group: "Aerospace & simulation",
   keywords: "aviation flight airplane king air c90 merlin",
   path: "M12 3v18m0-17 2 3v4l7 5v2l-7-2v3l3 2H7l3-2v-3l-7 2v-2l7-5V7Z"},
  {id: "propeller", label: "Propeller", group: "Aerospace & simulation",
   keywords: "turboprop pt6 propulsion engine",
   path: "M10 11C5 10 3 7 5 5s6 0 6 5m2 0c1-5 4-7 6-5s0 6-5 6m0 2c5 1 7 4 5 6s-6 0-6-5m-2 0c-1 5-4 7-6 5s0-6 5-6M14 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0"},
  {id: "control-loop", label: "Control loop", group: "Aerospace & simulation",
   keywords: "feedback pid control law gnc autopilot",
   path: "M8 7h8v7H8Zm-5 3h5m8 0h5v10H4v-6m-2 2 2-2 2 2M11 10h2"},
  {id: "simulation", label: "Simulation blocks", group: "Aerospace & simulation",
   keywords: "matlab simulink model system dynamics block diagram",
   path: "M2 8h6v8H2Zm14 0h6v8h-6ZM8 12h8m-3-3 3 3-3 3M5 8V4h14v4"},
  {id: "six-dof", label: "6-DOF dynamics", group: "Aerospace & simulation",
   keywords: "six dof quaternion attitude coordinate frame physics",
   path: "M12 12V3m-3 3 3-3 3 3m-3 6 8 6m-1-4 1 4-4 1m-4-7-8 6m4 1-4-1 1-4M9 10a4 4 0 0 1 7 2"},
  {id: "airflow", label: "Aerodynamics", group: "Aerospace & simulation",
   keywords: "cfd airflow avl vspaero openfoam wind tunnel airfoil",
   path: "M3 5h6c4 0 5 3 12 3M3 19h6c4 0 5-3 12-3M4 13c3-5 10-4 16 0-6 2-13 3-16 0Z"},
  {id: "telemetry", label: "Telemetry", group: "Aerospace & simulation",
   keywords: "signals flight test avionics sensor oscilloscope",
   path: "M3 5h18v14H3ZM5 12h3l2-4 4 8 2-4h3M8 22h8m-4-3v3"},
  {id: "satellite", label: "Satellite", group: "Aerospace & simulation",
   keywords: "space navigation gps orbit aerospace",
   path: "M9 9h6v6H9ZM2 6l4-4 4 4-4 4Zm12 12 4-4 4 4-4 4ZM15 9l4-4m-1-3 4 4M3 15a6 6 0 0 1 6 6m-6-3a3 3 0 0 1 3 3"},
  {id: "agent", label: "AI agent", group: "AI & agents",
   keywords: "alina assistant bot openclaw automation",
   path: "M6 7h12l2 3v9H4v-9ZM12 7V3m-2 0h4M8 12h1m6 0h1M8 16h8"},
  {id: "agent-team", label: "Agent team", group: "AI & agents",
   keywords: "multi agent swarm council delegation orchestration",
   path: "M14 5a2 2 0 1 1-4 0 2 2 0 0 1 4 0M7 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0m14 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0M12 7v5m-7 4v-4h14v4"},
  {id: "neural-net", label: "Neural network", group: "AI & agents",
   keywords: "llm post training learning model inference",
   path: "M6 5a2 2 0 1 1-4 0 2 2 0 0 1 4 0m0 14a2 2 0 1 1-4 0 2 2 0 0 1 4 0M14 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0m8-7a2 2 0 1 1-4 0 2 2 0 0 1 4 0m0 14a2 2 0 1 1-4 0 2 2 0 0 1 4 0M6 6l4 4m-4 8 4-4m4-4 4-4m-4 8 4 4"},
  {id: "memory", label: "Shared memory", group: "AI & agents",
   keywords: "recall knowledge rag embeddings context database",
   path: "M12 5C8 1 4 4 5 8c-4 1-3 7 0 8-1 4 4 6 7 3m0-14c4-4 8-1 7 3 4 1 3 7 0 8 1 4-4 6-7 3ZM8 8l4 3 4-3M7 15l5-2 5 2"},
  {id: "workflow", label: "Agent workflow", group: "AI & agents",
   keywords: "harness chain automation pipeline tasks",
   path: "M3 3h6v6H3Zm12 12h6v6h-6ZM9 6h9v9m-3-3 3 3 3-3M6 9v9h5"},
  {id: "factory", label: "Software factory", group: "AI & agents",
   keywords: "dark factory autonomous production build agents",
   path: "M3 21V9l6 4V8l6 4V3h5v18ZM6 17h1m4 0h1m4 0h1"},
  {id: "research", label: "Research", group: "AI & agents",
   keywords: "recon papers science search analysis",
   path: "M10 3h4m-3 0v7l-6 9q-1 2 2 2h10q3 0 2-2l-6-9V3M8 16h8m-5-3h2"},
  {id: "voice", label: "Voice assistant", group: "AI & agents",
   keywords: "speech audio linux voice cockpit transcription smart glasses",
   path: "M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0ZM5 11v1a7 7 0 0 0 14 0v-1M12 19v3m-4 0h8"},
  {id: "terminal", label: "Terminal", group: "Code & tools",
   keywords: "shell bash zsh nixos neovim cli clawterm warp",
   path: "M3 4h18v16H3Zm3 5 3 3-3 3m6 1h5"},
  {id: "code", label: "Code", group: "Code & tools",
   keywords: "software development programming python typescript javascript",
   path: "m8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18"},
  {id: "git", label: "Git branches", group: "Code & tools",
   keywords: "github repository pull request merge version control",
   path: "M8 5a2 2 0 1 1-4 0 2 2 0 0 1 4 0m0 14a2 2 0 1 1-4 0 2 2 0 0 1 4 0M20 7a2 2 0 1 1-4 0 2 2 0 0 1 4 0M6 7v10m12-8v2c0 5-12 1-12 6"},
  {id: "debug", label: "Debugging", group: "Code & tools",
   keywords: "bug repair fix trace troubleshooting",
   path: "M8 8h8v8a4 4 0 0 1-8 0ZM9 8V5h6v3M4 7l4 3m8 0 4-3M3 14h5m8 0h5M4 21l4-3m8 0 4 3M12 9v10"},
  {id: "tests", label: "Test suite", group: "Code & tools",
   keywords: "qa verification validation regression checks",
   path: "M5 3h14v18H5Zm3 5 1 1 2-2m2 1h3M8 14l1 1 2-2m2 1h3"},
  {id: "api", label: "API integration", group: "Code & tools",
   keywords: "mcp plugin sdk connector tools protocol",
   path: "M3 7h5v10H3Zm13 0h5v10h-5ZM8 12h8m-5-3 3 3-3 3M5 3v4m14 10v4"},
  {id: "package", label: "Package build", group: "Code & tools",
   keywords: "nix reproducible flake dependency release deployment",
   path: "m12 3 9 5v9l-9 5-9-5V8Zm-9 5 9 5 9-5m-9 5v9M7 5l9 5"},
  {id: "web", label: "Web application", group: "Code & tools",
   keywords: "website frontend browser portfolio dashboard ui ux",
   path: "M3 4h18v16H3ZM3 9h18M6 6h1m3 0h1M6 13h5v4H6Zm9 0h3m-3 4h3"},
  {id: "server", label: "Server rack", group: "Home lab & infrastructure",
   keywords: "home lab nova alina proxmox compute hardware",
   path: "M4 3h16v5H4Zm0 7h16v5H4Zm0 7h16v5H4ZM7 5h1m-1 7h1m-1 7h1m7-14h3m-3 7h3m-3 7h3"},
  {id: "cluster", label: "Compute cluster", group: "Home lab & infrastructure",
   keywords: "kubernetes k8s k3s orchestration nodes",
   path: "M9 3h6v5H9ZM2 16h6v5H2Zm14 0h6v5h-6ZM12 8v4m-7 4v-4h14v4"},
  {id: "storage", label: "Storage", group: "Home lab & infrastructure",
   keywords: "ceph distributed storage database sql backup",
   path: "M20 5c0 4-16 4-16 0s16-4 16 0ZM4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"},
  {id: "network", label: "Networking", group: "Home lab & infrastructure",
   keywords: "tailscale router dns vpn networking internet",
   path: "M4 13h16v7H4ZM7 13V7m10 6V7M7 17h1m3 0h1m3 0h2M2 5a16 16 0 0 1 20 0M5 8a11 11 0 0 1 14 0"},
  {id: "cloud", label: "Cloud compute", group: "Home lab & infrastructure",
   keywords: "aws gcp azure cloudflare cloud workers hosting",
   path: "M7 18H6a4 4 0 1 1 0-8 6 6 0 0 1 12-1 4.5 4.5 0 0 1 0 9h-1M12 21V12m-3 3 3-3 3 3"},
  {id: "chip", label: "GPU & hardware", group: "Home lab & infrastructure",
   keywords: "dgx spark raspberry pi embedded electronics hardware cpu gpu",
   path: "M6 6h12v12H6Zm3 3h6v6H9ZM9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4"},
  {id: "linux", label: "Linux systems", group: "Home lab & infrastructure",
   keywords: "nixos operating system desktop hyprland configuration",
   path: "M9 3h6v3l5 3-3 3 3 6-5 3H9l-5-3 3-6-3-3 5-3ZM9 9h1m4 0h1m-5 4h4M9 18h6"},
  {id: "observability", label: "Monitoring", group: "Home lab & infrastructure",
   keywords: "heartbeat logs metrics observability health uptime cron",
   path: "M2 12h4l3-8 6 16 3-8h4M4 4h2m12 16h2"},
  {id: "shield", label: "Security", group: "Security & reliability",
   keywords: "gatekeeper audit permissions policy protection",
   path: "m12 2 8 4v6c0 5-4 8-8 10-4-2-8-5-8-10V6Zm-4 10 3 3 5-6"},
  {id: "key", label: "Credentials", group: "Security & reliability",
   keywords: "oauth auth login secrets api key yubikey",
   path: "M11 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0Zm-1 3 10 10m-3-3 3-3m-6 0 3-3"},
  {id: "lock", label: "Privacy", group: "Security & reliability",
   keywords: "encrypted confidential access isolation vault",
   path: "M5 10h14v11H5ZM8 10V6a4 4 0 0 1 8 0v4M12 14v3"},
  {id: "scanner", label: "Security scan", group: "Security & reliability",
   keywords: "specter pentest vulnerability reverse engineering dissect",
   path: "M3 8V3h5m8 0h5v5M3 16v5h5m8 0h5v-5M2 12h20M8 8h8v8H8Z"},
  {id: "backup", label: "Backup & recovery", group: "Security & reliability",
   keywords: "restore rollback snapshot lifeline disaster",
   path: "M3 10a9 9 0 1 1 1 8M3 4v6h6M12 7v6l4 2"},
  {id: "review", label: "Review council", group: "Security & reliability",
   keywords: "advocate review verification governance approvals decision",
   path: "M5 3h14v18H5Zm3 5h8m-8 4h8m-8 4 2 2 5-4"},
  {id: "firewall", label: "Firewall", group: "Security & reliability",
   keywords: "network policy ingress gate access boundaries",
   path: "M3 4h18v16H3ZM3 9h18M3 15h18M9 4v5m6 0v6m-6 0v5"},
  {id: "incident", label: "Incident response", group: "Security & reliability",
   keywords: "alert rescue reliability ops outage triage",
   path: "m12 3 10 18H2ZM12 8v6m0 3v1"},
  {id: "consulting", label: "Consulting", group: "Business & career",
   keywords: "mangano consulting client business work",
   path: "M3 8h18v12H3ZM8 8V4h8v4M3 12l9 4 9-4m-9 2v4"},
  {id: "startup", label: "Startup", group: "Business & career",
   keywords: "controlstackai entrepreneurship venture launch company",
   path: "M8 16c0-8 6-12 13-13 0 7-5 13-13 13Zm0-6H4l-2 5h6m6 1v4l-5 2v-6M5 18l-3 4m14-14h1"},
  {id: "strategy", label: "Strategy", group: "Business & career",
   keywords: "atlas planning architecture roadmap milestones goals",
   path: "M3 3v18h18M6 16l5-5 4 2 6-8m-5 0h5v5"},
  {id: "career", label: "Career search", group: "Business & career",
   keywords: "jobs resume interview applications hiring portfolio",
   path: "M7 3h10v18H7Zm3 4h4m-4 4h4M4 9H2v12h3m15-12h2v12h-3M10 16h4"},
  {id: "meeting", label: "Meetings", group: "Business & career",
   keywords: "calendar events appointments scheduling meetup",
   path: "M3 5h18v16H3ZM7 2v6m10-6v6M3 10h18M7 14h3m4 0h3m-10 4h3"},
  {id: "handshake", label: "Partnerships", group: "Business & career",
   keywords: "sales negotiation networking deal truss acquihire",
   path: "m2 9 4-4 5 2 3-2 8 6-4 8-5 2-7-6Zm4-4 5 2-3 4 3 2 4-3 6 5M6 15l5 4m-2-6 6 6"},
  {id: "documents", label: "Documents", group: "Business & career",
   keywords: "contracts proposal specification writing pdf word",
   path: "M5 2h9l5 5v15H5ZM14 2v6h5M8 12h8m-8 4h8m-8 3h5"},
  {id: "mail", label: "Email", group: "Business & career",
   keywords: "gmail inbox communication outreach messages",
   path: "M3 5h18v14H3Zm0 0 9 8 9-8M3 19l6-6m6 0 6 6"},
  {id: "markets", label: "Markets", group: "Finance & markets",
   keywords: "investing stocks robinhood trading ledger",
   path: "M3 20V4m0 16h18M6 15l5-5 4 2 6-8m-5 0h5v5"},
  {id: "bitcoin", label: "Bitcoin", group: "Finance & markets",
   keywords: "crypto sats cryptocurrency blockchain",
   path: "M9 4v16m-3-3h10a3 3 0 0 0 0-6H9m0 0h6a3 3 0 0 0 0-6H6M12 2v3m3-3v3m-3 12v5m3-5v5"},
  {id: "wallet", label: "Budget", group: "Finance & markets",
   keywords: "spending wallet personal finance cost budget",
   path: "M3 6h17v15H3Zm0 0V3h15v3m-1 6h5v5h-5Zm2 2h1"},
  {id: "credit", label: "Credit repair", group: "Finance & markets",
   keywords: "credit score debt credit karma card",
   path: "M3 5h18v14H3ZM3 10h18M6 15h4m5 0h3"},
  {id: "savings", label: "Savings", group: "Finance & markets",
   keywords: "bank money cash emergency fund",
   path: "M5 10h14v9h-2v3h-3v-3H9v3H6v-4H3v-6h2l1-5 4 3M9 6h6m4 5h3v5h-3M15 13h1"},
  {id: "receipt", label: "Expenses", group: "Finance & markets",
   keywords: "invoices billing receipts consulting taxes subscriptions",
   path: "M5 2l3 2 4-2 4 2 3-2v20l-3-2-4 2-4-2-3 2ZM8 8h8m-8 4h8m-8 4h5"},
  {id: "analysis", label: "Market analysis", group: "Finance & markets",
   keywords: "chart data analytics economic research ai bubble",
   path: "M3 21V3m0 18h18M7 17V9m5 8V5m5 12v-5M6 6l6-3 7 4"},
  {id: "value", label: "Cost optimization", group: "Finance & markets",
   keywords: "cloud spend api pricing usage efficiency dollars",
   path: "M12 2v20M17 6h-7a4 4 0 0 0 0 8h4a4 4 0 0 0 0-8H7M4 4l-2 3m18 10 2 3"},
  {id: "video", label: "Video production", group: "Creative & media",
   keywords: "studio youtube shorts film heygen higgsfield",
   path: "M3 6h12v12H3Zm12 4 6-4v12l-6-4Z"},
  {id: "camera", label: "Photography", group: "Creative & media",
   keywords: "photo image camera visual instagram",
   path: "M3 7h5l2-3h4l2 3h5v13H3ZM16 13a4 4 0 1 1-8 0 4 4 0 0 1 8 0"},
  {id: "design", label: "Design", group: "Creative & media",
   keywords: "brand art creative muse logo visual ui ux",
   path: "M12 3a9 9 0 1 0 0 18h2a2 2 0 0 0 0-4h-1a2 2 0 0 1 0-4h5c6 0 3-10-6-10ZM7 8h.1m4-2h.1m5 2h.1M5 13h.1"},
  {id: "audio", label: "Audio production", group: "Creative & media",
   keywords: "podcast sound voice recording music production",
   path: "M4 8v8m4-12v16m4-18v20m4-16v12m4-8v4"},
  {id: "writing", label: "Writing", group: "Creative & media",
   keywords: "content copy notes scripts blog publishing",
   path: "m4 16 12-12 4 4L8 20l-5 1Zm9-9 4 4M3 21h18"},
  {id: "social", label: "Social media", group: "Creative & media",
   keywords: "linkedin instagram marketing audience posts outreach",
   path: "M8 5a2 2 0 1 1-4 0 2 2 0 0 1 4 0m14 7a2 2 0 1 1-4 0 2 2 0 0 1 4 0M8 19a2 2 0 1 1-4 0 2 2 0 0 1 4 0M8 6l10 5M8 18l10-5"},
  {id: "presentation", label: "Presentations", group: "Creative & media",
   keywords: "slides pitch deck ppt demo showcase",
   path: "M2 3h20M4 3v13h16V3M12 16v6m-5 0 5-4 5 4M7 12l4-5 3 3 3-4"},
  {id: "smart-glasses", label: "Smart glasses", group: "Creative & media",
   keywords: "wearable ar vr spatial computer camera",
   path: "M2 9h8v7H2Zm12 0h8v7h-8ZM10 11h4M2 9l2-6h3m15 6-2-6h-3"},
  {id: "surf", label: "Surf & ocean", group: "Life & interests",
   keywords: "surfing waves beach buoy huntington newport conditions",
   path: "M2 17q3-4 6 0t6 0 8 0M2 21q3-4 6 0t6 0 8 0M8 13C9 7 13 3 17 2c1 5-1 9-5 12m-2-2 5-7"},
  {id: "coffee", label: "Coffee", group: "Life & interests",
   keywords: "cafe ralph coffee breakfast espresso",
   path: "M3 6h12v10a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Zm12 1h3a3 3 0 0 1 0 6h-3M6 2v1m5-1v1M2 23h16"},
  {id: "dining", label: "Dining", group: "Life & interests",
   keywords: "food restaurants doordash dinner date night",
   path: "M3 2v6a3 3 0 0 0 6 0V2M6 2v20m11 0V2c-4 3-4 10 0 10h3V2"},
  {id: "live-music", label: "Live music", group: "Life & interests",
   keywords: "concert event jazz tickets entertainment",
   path: "M9 18V5l11-3v13M9 9l11-3M9 18a3 2 0 1 1-6 0 3 2 0 0 1 6 0m11-3a3 2 0 1 1-6 0 3 2 0 0 1 6 0"},
  {id: "comedy", label: "Comedy & shows", group: "Life & interests",
   keywords: "comedy live show theater theatre entertainment tickets",
   path: "M3 3l8 2v7c0 4-5 7-8 2ZM5 7h1m2 1h1m-4 3q2 3 4 0M13 8l8-2v10c0 4-5 7-8 2ZM15 12h1m2-1h1m-4 7q2-3 4-1"},
  {id: "travel", label: "Travel & outings", group: "Life & interests",
   keywords: "trip vacation vegas hotel itinerary birthday adventure",
   path: "M4 6h16v15H4ZM9 6V2h6v4M8 6v15m8-15v15M7 21v2m10-2v2"},
  {id: "home", label: "Home & moving", group: "Life & interests",
   keywords: "apartment housing property real estate newport lease",
   path: "m2 11 10-8 10 8M5 9v12h14V9M10 21v-7h4v7"},
  {id: "health", label: "Health & wellbeing", group: "Life & interests",
   keywords: "fitness wellness medical care personal partner",
   path: "M12 21 3 12C-2 6 6 0 12 7c6-7 14-1 9 5ZM4 12h4l2-3 4 7 2-4h4"},
];

const ARTWORK = {
  "aircraft":
    "<path d=\"M12 2l2 5v4l8 5v3l-8-3v4l3 2H7l3-2v-4l-8 3v-3l8-5V7Z\" fill=\"#38bdf8\"/><path d=\"M12 2l2 5v13l3 2h-5Z\" fill=\"#a78bfa\"/><path d=\"M11 8h2\" fill=\"none\" stroke=\"#f8fafc\" stroke-width=\"2\"/><path d=\"M2 16l3-2v4l-3 1Z\" fill=\"#fb923c\"/>",
  "propeller":
    "<path d=\"M11 11C3 10 1 3 6 3c4 0 5 5 5 8\" fill=\"#38bdf8\"/><path d=\"M13 11c0-8 7-10 8-5 0 4-5 5-8 5\" fill=\"#f472b6\"/><path d=\"M13 13c8 0 10 7 5 8-4 0-5-5-5-8\" fill=\"#fb923c\"/><path d=\"M11 13c0 8-7 10-8 5 0-4 5-5 8-5\" fill=\"#34d399\"/><circle cx=\"12\" cy=\"12\" r=\"3\" fill=\"#facc15\"/><circle cx=\"12\" cy=\"12\" r=\"1\" fill=\"#334155\"/>",
  "control-loop":
    "<path d=\"M2 10h19v10H4v-5\" fill=\"none\" stroke=\"#a78bfa\" stroke-width=\"2\"/><rect x=\"7\" y=\"5\" width=\"10\" height=\"10\" rx=\"1.5\" fill=\"#38bdf8\"/><path d=\"M10 10h4\" fill=\"none\" stroke=\"#f8fafc\" stroke-width=\"2\"/><path d=\"M1 16l3-4 3 4Z\" fill=\"#fb923c\"/>",
  "simulation":
    "<path d=\"M5 8V4h14v4M8 12h8\" fill=\"none\" stroke=\"#a78bfa\" stroke-width=\"2\"/><rect x=\"1\" y=\"8\" width=\"7\" height=\"9\" rx=\"1.5\" fill=\"#38bdf8\"/><rect x=\"16\" y=\"8\" width=\"7\" height=\"9\" rx=\"1.5\" fill=\"#fb923c\"/><path d=\"M11 9l4 3-4 3Z\" fill=\"#facc15\"/><path d=\"M3 12h3M18 12h3\" fill=\"none\" stroke=\"#f8fafc\" stroke-width=\"1.5\"/>",
  "six-dof":
    "<path d=\"M12 12V3\" fill=\"none\" stroke=\"#38bdf8\" stroke-width=\"2.5\"/><path d=\"M12 1l-3 4h6Z\" fill=\"#38bdf8\"/><path d=\"M12 12l8 6\" fill=\"none\" stroke=\"#f472b6\" stroke-width=\"2.5\"/><path d=\"M22 20l-6-1 4-4Z\" fill=\"#f472b6\"/><path d=\"M12 12l-8 6\" fill=\"none\" stroke=\"#34d399\" stroke-width=\"2.5\"/><path d=\"M2 20l2-5 4 4Z\" fill=\"#34d399\"/><circle cx=\"12\" cy=\"12\" r=\"2.5\" fill=\"#facc15\"/>",
  "airflow":
    "<path d=\"M2 5h7c4 0 5 3 13 3\" fill=\"none\" stroke=\"#22d3ee\" stroke-width=\"2\"/><path d=\"M2 19h7c4 0 5-3 13-3\" fill=\"none\" stroke=\"#a78bfa\" stroke-width=\"2\"/><path d=\"M3 13c4-6 12-3 18 0-7 3-14 3-18 0Z\" fill=\"#38bdf8\"/><path d=\"M3 13h18c-7 3-14 3-18 0Z\" fill=\"#fb923c\"/>",
  "telemetry":
    "<rect x=\"2\" y=\"3\" width=\"20\" height=\"16\" rx=\"1.5\" fill=\"#334155\"/><rect x=\"4\" y=\"5\" width=\"16\" height=\"12\" rx=\"1.5\" fill=\"#38bdf8\"/><path d=\"M5 11h3l2-4 4 8 2-4h3\" fill=\"none\" stroke=\"#facc15\" stroke-width=\"2\"/><path d=\"M12 19v3M7 22h10\" fill=\"none\" stroke=\"#a78bfa\" stroke-width=\"2\"/>",
  "satellite":
    "<path d=\"M1 6l5-5 5 5-5 5Z\" fill=\"#38bdf8\"/><path d=\"M13 18l5-5 5 5-5 5Z\" fill=\"#a78bfa\"/><path d=\"M8 9l4-3 6 7-4 4Z\" fill=\"#facc15\"/><path d=\"M14 8l5-5M17 2l5 5\" fill=\"none\" stroke=\"#fb923c\" stroke-width=\"2\"/><path d=\"M2 15a7 7 0 0 1 7 7M2 19a3 3 0 0 1 3 3\" fill=\"none\" stroke=\"#22d3ee\" stroke-width=\"2\"/>",
  "agent":
    "<path d=\"M12 4v4\" fill=\"none\" stroke=\"#a78bfa\" stroke-width=\"2\"/><circle cx=\"12\" cy=\"3\" r=\"2\" fill=\"#f472b6\"/><rect x=\"3\" y=\"7\" width=\"18\" height=\"14\" rx=\"4\" fill=\"#38bdf8\"/><rect x=\"6\" y=\"10\" width=\"12\" height=\"7\" rx=\"2\" fill=\"#334155\"/><circle cx=\"9\" cy=\"13\" r=\"1.5\" fill=\"#facc15\"/><circle cx=\"15\" cy=\"13\" r=\"1.5\" fill=\"#34d399\"/><path d=\"M9 19h6\" fill=\"none\" stroke=\"#a78bfa\" stroke-width=\"2\"/><rect x=\"1\" y=\"11\" width=\"2\" height=\"6\" rx=\"1.5\" fill=\"#fb923c\"/><rect x=\"21\" y=\"11\" width=\"2\" height=\"6\" rx=\"1.5\" fill=\"#fb923c\"/>",
  "agent-team":
    "<path d=\"M12 7v5M5 16v-4h14v4\" fill=\"none\" stroke=\"#a78bfa\" stroke-width=\"2\"/><circle cx=\"12\" cy=\"5\" r=\"4\" fill=\"#38bdf8\"/><circle cx=\"5\" cy=\"18\" r=\"4\" fill=\"#f472b6\"/><circle cx=\"19\" cy=\"18\" r=\"4\" fill=\"#fb923c\"/><circle cx=\"12\" cy=\"4\" r=\"1.2\" fill=\"#f8fafc\"/><circle cx=\"5\" cy=\"17\" r=\"1.2\" fill=\"#f8fafc\"/><circle cx=\"19\" cy=\"17\" r=\"1.2\" fill=\"#f8fafc\"/>",
  "neural-net":
    "<path d=\"M4 4l8 8-8 8M20 4l-8 8 8 8\" fill=\"none\" stroke=\"#a78bfa\" stroke-width=\"2\"/><circle cx=\"4\" cy=\"4\" r=\"3\" fill=\"#38bdf8\"/><circle cx=\"4\" cy=\"20\" r=\"3\" fill=\"#34d399\"/><circle cx=\"20\" cy=\"4\" r=\"3\" fill=\"#f472b6\"/><circle cx=\"20\" cy=\"20\" r=\"3\" fill=\"#fb923c\"/><circle cx=\"12\" cy=\"12\" r=\"3.5\" fill=\"#facc15\"/>",
  "memory":
    "<path d=\"M12 5C8 1 4 4 5 8c-4 1-3 7 0 8-1 4 4 6 7 3Z\" fill=\"#f472b6\"/><path d=\"M12 5c4-4 8-1 7 3 4 1 3 7 0 8 1 4-4 6-7 3Z\" fill=\"#a78bfa\"/><path d=\"M7 8l5 3 5-3M7 15l5-2 5 2\" fill=\"none\" stroke=\"#facc15\" stroke-width=\"1.5\"/>",
  "workflow":
    "<path d=\"M7 6h11v12M6 8v10h11\" fill=\"none\" stroke=\"#a78bfa\" stroke-width=\"2\"/><rect x=\"2\" y=\"2\" width=\"8\" height=\"8\" rx=\"1.5\" fill=\"#38bdf8\"/><rect x=\"14\" y=\"14\" width=\"8\" height=\"8\" rx=\"1.5\" fill=\"#f472b6\"/><path d=\"M15 11l3 4 3-4Z\" fill=\"#facc15\"/><circle cx=\"6\" cy=\"6\" r=\"1.5\" fill=\"#f8fafc\"/><circle cx=\"18\" cy=\"18\" r=\"1.5\" fill=\"#f8fafc\"/>",
  "factory":
    "<path d=\"M3 21V9l6 4V8l6 4V3h5v18Z\" fill=\"#a78bfa\"/><rect x=\"15\" y=\"2\" width=\"5\" height=\"6\" rx=\"1.5\" fill=\"#f472b6\"/><rect x=\"3\" y=\"16\" width=\"17\" height=\"6\" rx=\"0\" fill=\"#38bdf8\"/><rect x=\"6\" y=\"17\" width=\"2\" height=\"3\" rx=\"0.5\" fill=\"#facc15\"/><rect x=\"11\" y=\"17\" width=\"2\" height=\"3\" rx=\"0.5\" fill=\"#facc15\"/><rect x=\"16\" y=\"17\" width=\"2\" height=\"3\" rx=\"0.5\" fill=\"#facc15\"/>",
  "research":
    "<path d=\"M9 2h6v2h-1v6l6 9q1 3-2 3H6q-3 0-2-3l6-9V4H9Z\" fill=\"#38bdf8\"/><path d=\"M7 15h10l3 4q1 3-2 3H6q-3 0-2-3Z\" fill=\"#a78bfa\"/><circle cx=\"10\" cy=\"18\" r=\"1.5\" fill=\"#facc15\"/><circle cx=\"14\" cy=\"12\" r=\"1\" fill=\"#f472b6\"/><circle cx=\"15\" cy=\"20\" r=\"1\" fill=\"#22d3ee\"/>",
  "voice":
    "<rect x=\"8\" y=\"1\" width=\"8\" height=\"15\" rx=\"4\" fill=\"#f472b6\"/><rect x=\"8\" y=\"1\" width=\"8\" height=\"7\" rx=\"4\" fill=\"#a78bfa\"/><path d=\"M4 11v1a8 8 0 0 0 16 0v-1M12 20v3M8 23h8\" fill=\"none\" stroke=\"#38bdf8\" stroke-width=\"2\"/><path d=\"M10 10h4M10 13h4\" fill=\"none\" stroke=\"#f8fafc\" stroke-width=\"1.5\"/>",
  "terminal":
    "<rect x=\"2\" y=\"3\" width=\"20\" height=\"18\" rx=\"1.5\" fill=\"#334155\"/><rect x=\"2\" y=\"3\" width=\"20\" height=\"4\" rx=\"1.5\" fill=\"#a78bfa\"/><circle cx=\"5\" cy=\"5\" r=\"1\" fill=\"#fb7185\"/><circle cx=\"8\" cy=\"5\" r=\"1\" fill=\"#facc15\"/><circle cx=\"11\" cy=\"5\" r=\"1\" fill=\"#34d399\"/><path d=\"M6 11l3 3-3 3\" fill=\"none\" stroke=\"#34d399\" stroke-width=\"2\"/><path d=\"M12 18h6\" fill=\"none\" stroke=\"#38bdf8\" stroke-width=\"2\"/>",
  "code":
    "<path d=\"M7 5l-6 7 6 7\" fill=\"none\" stroke=\"#38bdf8\" stroke-width=\"3\"/><path d=\"M17 5l6 7-6 7\" fill=\"none\" stroke=\"#f472b6\" stroke-width=\"3\"/><path d=\"M14 3l-4 18\" fill=\"none\" stroke=\"#facc15\" stroke-width=\"2.5\"/>",
  "git":
    "<path d=\"M6 4v16M18 6v5c0 5-12 1-12 7\" fill=\"none\" stroke=\"#a78bfa\" stroke-width=\"2.5\"/><circle cx=\"6\" cy=\"4\" r=\"3\" fill=\"#fb923c\"/><circle cx=\"6\" cy=\"20\" r=\"3\" fill=\"#f472b6\"/><circle cx=\"18\" cy=\"6\" r=\"3\" fill=\"#34d399\"/>",
  "debug":
    "<path d=\"M4 6l4 4M16 10l4-4M3 14h18M4 22l4-4M16 18l4 4\" fill=\"none\" stroke=\"#a78bfa\" stroke-width=\"2\"/><rect x=\"8\" y=\"4\" width=\"8\" height=\"6\" rx=\"3\" fill=\"#fb923c\"/><path d=\"M7 9h10v8a5 5 0 0 1-10 0Z\" fill=\"#34d399\"/><path d=\"M12 10v11\" fill=\"none\" stroke=\"#334155\" stroke-width=\"1.5\"/><circle cx=\"10\" cy=\"6\" r=\"1\" fill=\"#facc15\"/><circle cx=\"14\" cy=\"6\" r=\"1\" fill=\"#facc15\"/>",
  "tests":
    "<path d=\"M5 2h9l5 5v15H5Z\" fill=\"#38bdf8\"/><path d=\"M14 2v6h5\" fill=\"#a78bfa\"/><path d=\"M8 8l1 1 2-3M8 15l1 1 2-3\" fill=\"none\" stroke=\"#34d399\" stroke-width=\"2\"/><path d=\"M14 8h2M14 15h2M8 19h8\" fill=\"none\" stroke=\"#f8fafc\" stroke-width=\"1.5\"/>",
  "api":
    "<path d=\"M7 12h10M5 2v5M19 17v5\" fill=\"none\" stroke=\"#a78bfa\" stroke-width=\"2\"/><rect x=\"2\" y=\"6\" width=\"7\" height=\"12\" rx=\"1.5\" fill=\"#38bdf8\"/><rect x=\"15\" y=\"6\" width=\"7\" height=\"12\" rx=\"1.5\" fill=\"#fb923c\"/><path d=\"M10 9l4 3-4 3Z\" fill=\"#facc15\"/><path d=\"M5 10v4M18 10v4\" fill=\"none\" stroke=\"#f8fafc\" stroke-width=\"1.5\"/>",
  "package":
    "<path d=\"M12 2l10 5v11l-10 5-10-5V7Z\" fill=\"#fb923c\"/><path d=\"M2 7l10 5v11L2 18Z\" fill=\"#facc15\"/><path d=\"M12 12l10-5v11l-10 5Z\" fill=\"#f472b6\"/><path d=\"M7 4l10 5v5l-3 1v-5L4 6Z\" fill=\"#a78bfa\"/>",
  "web":
    "<rect x=\"2\" y=\"3\" width=\"20\" height=\"18\" rx=\"1.5\" fill=\"#38bdf8\"/><rect x=\"2\" y=\"3\" width=\"20\" height=\"5\" rx=\"1.5\" fill=\"#a78bfa\"/><circle cx=\"5\" cy=\"5.5\" r=\"1\" fill=\"#fb7185\"/><circle cx=\"8\" cy=\"5.5\" r=\"1\" fill=\"#facc15\"/><rect x=\"4\" y=\"11\" width=\"7\" height=\"7\" rx=\"1.5\" fill=\"#f472b6\"/><path d=\"M14 12h5M14 16h4\" fill=\"none\" stroke=\"#f8fafc\" stroke-width=\"1.7\"/>",
  "server":
    "<rect x=\"3\" y=\"2\" width=\"18\" height=\"6\" rx=\"1.5\" fill=\"#a78bfa\"/><rect x=\"3\" y=\"9\" width=\"18\" height=\"6\" rx=\"1.5\" fill=\"#38bdf8\"/><rect x=\"3\" y=\"16\" width=\"18\" height=\"6\" rx=\"1.5\" fill=\"#22d3ee\"/><circle cx=\"6\" cy=\"5\" r=\"1.2\" fill=\"#facc15\"/><circle cx=\"6\" cy=\"12\" r=\"1.2\" fill=\"#34d399\"/><circle cx=\"6\" cy=\"19\" r=\"1.2\" fill=\"#f472b6\"/><path d=\"M13 5h5M13 12h5M13 19h5\" fill=\"none\" stroke=\"#334155\" stroke-width=\"1.5\"/>",
  "cluster":
    "<path d=\"M12 7v6M5 18v-5h14v5\" fill=\"none\" stroke=\"#a78bfa\" stroke-width=\"2\"/><rect x=\"8\" y=\"1\" width=\"8\" height=\"7\" rx=\"1.5\" fill=\"#38bdf8\"/><rect x=\"1\" y=\"16\" width=\"8\" height=\"7\" rx=\"1.5\" fill=\"#34d399\"/><rect x=\"15\" y=\"16\" width=\"8\" height=\"7\" rx=\"1.5\" fill=\"#f472b6\"/><path d=\"M10 4h4M3 19h4M17 19h4\" fill=\"none\" stroke=\"#f8fafc\" stroke-width=\"1.5\"/>",
  "storage":
    "<path d=\"M3 5v14c0 5 18 5 18 0V5Z\" fill=\"#a78bfa\"/><path d=\"M3 12v7c0 5 18 5 18 0v-7c0 5-18 5-18 0Z\" fill=\"#38bdf8\"/><path d=\"M21 5c0 5-18 5-18 0s18-5 18 0Z\" fill=\"#22d3ee\"/><circle cx=\"18\" cy=\"17\" r=\"1.3\" fill=\"#facc15\"/>",
  "network":
    "<path d=\"M6 14V8M18 14V8\" fill=\"none\" stroke=\"#a78bfa\" stroke-width=\"2\"/><rect x=\"2\" y=\"13\" width=\"20\" height=\"8\" rx=\"1.5\" fill=\"#38bdf8\"/><path d=\"M2 4a17 17 0 0 1 20 0M6 8a10 10 0 0 1 12 0\" fill=\"none\" stroke=\"#34d399\" stroke-width=\"2\"/><circle cx=\"6\" cy=\"17\" r=\"1.2\" fill=\"#facc15\"/><circle cx=\"10\" cy=\"17\" r=\"1.2\" fill=\"#f472b6\"/><path d=\"M15 17h4\" fill=\"none\" stroke=\"#334155\" stroke-width=\"2\"/>",
  "cloud":
    "<path d=\"M6 19a5 5 0 1 1-1-10 7 7 0 0 1 13-2 6 6 0 0 1 0 12Z\" fill=\"#38bdf8\"/><path d=\"M12 11l6 6h-4v6h-4v-6H6Z\" fill=\"#a78bfa\"/><path d=\"M12 11l6 6h-4v6h-2Z\" fill=\"#f472b6\"/>",
  "chip":
    "<path d=\"M8 1v22M16 1v22M1 8h22M1 16h22\" fill=\"none\" stroke=\"#facc15\" stroke-width=\"2\"/><rect x=\"4\" y=\"4\" width=\"16\" height=\"16\" rx=\"3\" fill=\"#a78bfa\"/><rect x=\"7\" y=\"7\" width=\"10\" height=\"10\" rx=\"2\" fill=\"#38bdf8\"/><path d=\"M13 7l-4 6h3l-1 4 5-6h-3Z\" fill=\"#34d399\"/>",
  "linux":
    "<path d=\"M8 3q4-4 8 0l1 6 4 9-4 3H7l-4-3 4-9Z\" fill=\"#334155\"/><path d=\"M9 9h6l3 10H6Z\" fill=\"#f8fafc\"/><circle cx=\"10\" cy=\"6\" r=\"1.4\" fill=\"#f8fafc\"/><circle cx=\"14\" cy=\"6\" r=\"1.4\" fill=\"#f8fafc\"/><path d=\"M9 8h6l-3 3Z\" fill=\"#fb923c\"/><rect x=\"3\" y=\"20\" width=\"8\" height=\"3\" rx=\"1.5\" fill=\"#facc15\"/><rect x=\"13\" y=\"20\" width=\"8\" height=\"3\" rx=\"1.5\" fill=\"#facc15\"/><circle cx=\"10\" cy=\"6\" r=\"0.5\" fill=\"#334155\"/><circle cx=\"14\" cy=\"6\" r=\"0.5\" fill=\"#334155\"/>",
  "observability":
    "<rect x=\"1\" y=\"3\" width=\"22\" height=\"18\" rx=\"3\" fill=\"#334155\"/><path d=\"M2 12h4l3-7 6 14 3-7h4\" fill=\"none\" stroke=\"#34d399\" stroke-width=\"2.2\"/><circle cx=\"19\" cy=\"6\" r=\"1.5\" fill=\"#f472b6\"/><path d=\"M5 20h3\" fill=\"none\" stroke=\"#38bdf8\" stroke-width=\"2\"/>",
  "shield":
    "<path d=\"M12 1l9 4v7c0 5-4 8-9 11-5-3-9-6-9-11V5Z\" fill=\"#34d399\"/><path d=\"M12 1l9 4v7c0 5-4 8-9 11Z\" fill=\"#38bdf8\"/><path d=\"M7 12l4 4 6-8\" fill=\"none\" stroke=\"#facc15\" stroke-width=\"2.5\"/>",
  "key":
    "<circle cx=\"7\" cy=\"7\" r=\"6\" fill=\"#facc15\"/><circle cx=\"7\" cy=\"7\" r=\"2.5\" fill=\"#fb923c\"/><path d=\"M11 11l10 10M17 17l3-3M14 14l3-3\" fill=\"none\" stroke=\"#a78bfa\" stroke-width=\"3\"/>",
  "lock":
    "<path d=\"M7 11V6a5 5 0 0 1 10 0v5\" fill=\"none\" stroke=\"#38bdf8\" stroke-width=\"3\"/><rect x=\"3\" y=\"9\" width=\"18\" height=\"14\" rx=\"3\" fill=\"#a78bfa\"/><circle cx=\"12\" cy=\"15\" r=\"2\" fill=\"#facc15\"/><rect x=\"11\" y=\"15\" width=\"2\" height=\"4\" rx=\"1.5\" fill=\"#facc15\"/><rect x=\"5\" y=\"11\" width=\"3\" height=\"9\" rx=\"1\" fill=\"#f472b6\"/>",
  "scanner":
    "<path d=\"M2 7V2h5M17 2h5v5M2 17v5h5M17 22h5v-5\" fill=\"none\" stroke=\"#a78bfa\" stroke-width=\"2\"/><rect x=\"6\" y=\"6\" width=\"12\" height=\"12\" rx=\"1.5\" fill=\"#38bdf8\"/><path d=\"M1 12h22\" fill=\"none\" stroke=\"#f472b6\" stroke-width=\"2.5\"/><circle cx=\"12\" cy=\"12\" r=\"2\" fill=\"#facc15\"/>",
  "backup":
    "<path d=\"M3 10a9 9 0 1 1 1 8\" fill=\"none\" stroke=\"#38bdf8\" stroke-width=\"3\"/><path d=\"M1 4v8h8Z\" fill=\"#34d399\"/><path d=\"M12 6v7l4 2\" fill=\"none\" stroke=\"#a78bfa\" stroke-width=\"2.5\"/><circle cx=\"12\" cy=\"12\" r=\"1.5\" fill=\"#facc15\"/>",
  "review":
    "<path d=\"M5 2h9l5 5v15H5Z\" fill=\"#a78bfa\"/><path d=\"M14 2v6h5\" fill=\"#a78bfa\"/><path d=\"M8 8h8M8 12h8\" fill=\"none\" stroke=\"#f8fafc\" stroke-width=\"1.5\"/><circle cx=\"16\" cy=\"18\" r=\"5\" fill=\"#34d399\"/><path d=\"M13 18l2 2 4-4\" fill=\"none\" stroke=\"#facc15\" stroke-width=\"2\"/>",
  "firewall":
    "<rect x=\"2\" y=\"3\" width=\"20\" height=\"18\" rx=\"1.5\" fill=\"#fb923c\"/><rect x=\"3\" y=\"4\" width=\"6\" height=\"4\" rx=\"0.5\" fill=\"#facc15\"/><rect x=\"11\" y=\"4\" width=\"10\" height=\"4\" rx=\"0.5\" fill=\"#fb7185\"/><rect x=\"3\" y=\"10\" width=\"10\" height=\"4\" rx=\"0.5\" fill=\"#f472b6\"/><rect x=\"15\" y=\"10\" width=\"6\" height=\"4\" rx=\"0.5\" fill=\"#facc15\"/><rect x=\"3\" y=\"16\" width=\"6\" height=\"4\" rx=\"0.5\" fill=\"#fb7185\"/><rect x=\"11\" y=\"16\" width=\"10\" height=\"4\" rx=\"0.5\" fill=\"#a78bfa\"/>",
  "incident":
    "<path d=\"M12 1L24 22H0Z\" fill=\"#facc15\"/><path d=\"M12 1l12 21H12Z\" fill=\"#fb923c\"/><rect x=\"11\" y=\"7\" width=\"2\" height=\"8\" rx=\"1.5\" fill=\"#334155\"/><circle cx=\"12\" cy=\"18\" r=\"1.5\" fill=\"#fb7185\"/>",
  "consulting":
    "<path d=\"M8 8V3h8v5\" fill=\"none\" stroke=\"#a78bfa\" stroke-width=\"3\"/><rect x=\"2\" y=\"7\" width=\"20\" height=\"15\" rx=\"1.5\" fill=\"#38bdf8\"/><path d=\"M2 7h20v6l-10 4-10-4Z\" fill=\"#a78bfa\"/><rect x=\"10\" y=\"13\" width=\"4\" height=\"5\" rx=\"1\" fill=\"#facc15\"/>",
  "startup":
    "<path d=\"M8 16C7 9 14 2 22 2c0 8-7 15-14 14Z\" fill=\"#38bdf8\"/><path d=\"M14 15v6l-6 2v-7M8 10H3l-2 6h7\" fill=\"#a78bfa\"/><path d=\"M7 17l-2 6 6-4Z\" fill=\"#fb923c\"/><path d=\"M7 18l-1 3 3-2Z\" fill=\"#facc15\"/><circle cx=\"16\" cy=\"8\" r=\"3\" fill=\"#f472b6\"/><circle cx=\"16\" cy=\"8\" r=\"1.5\" fill=\"#f8fafc\"/>",
  "strategy":
    "<path d=\"M3 2v20h19\" fill=\"none\" stroke=\"#a78bfa\" stroke-width=\"2\"/><path d=\"M6 17l5-6 4 2 6-9\" fill=\"none\" stroke=\"#34d399\" stroke-width=\"2.5\"/><path d=\"M15 3h7v7Z\" fill=\"#38bdf8\"/><circle cx=\"11\" cy=\"11\" r=\"2\" fill=\"#facc15\"/>",
  "career":
    "<rect x=\"5\" y=\"1\" width=\"14\" height=\"22\" rx=\"1.5\" fill=\"#38bdf8\"/><rect x=\"8\" y=\"4\" width=\"8\" height=\"7\" rx=\"1.5\" fill=\"#a78bfa\"/><circle cx=\"12\" cy=\"6\" r=\"1.7\" fill=\"#facc15\"/><path d=\"M8 11q0-5 8 0Z\" fill=\"#f472b6\"/><path d=\"M8 15h8M8 19h5\" fill=\"none\" stroke=\"#f8fafc\" stroke-width=\"1.7\"/><rect x=\"1\" y=\"10\" width=\"3\" height=\"12\" rx=\"1.5\" fill=\"#34d399\"/><rect x=\"20\" y=\"10\" width=\"3\" height=\"12\" rx=\"1.5\" fill=\"#fb923c\"/>",
  "meeting":
    "<rect x=\"2\" y=\"4\" width=\"20\" height=\"19\" rx=\"1.5\" fill=\"#38bdf8\"/><rect x=\"2\" y=\"4\" width=\"20\" height=\"6\" rx=\"1.5\" fill=\"#f472b6\"/><path d=\"M7 1v6M17 1v6\" fill=\"none\" stroke=\"#a78bfa\" stroke-width=\"3\"/><rect x=\"5\" y=\"13\" width=\"4\" height=\"3\" rx=\"0.5\" fill=\"#facc15\"/><rect x=\"11\" y=\"13\" width=\"4\" height=\"3\" rx=\"0.5\" fill=\"#f8fafc\"/><rect x=\"5\" y=\"18\" width=\"4\" height=\"3\" rx=\"0.5\" fill=\"#f8fafc\"/><rect x=\"17\" y=\"13\" width=\"3\" height=\"8\" rx=\"0.5\" fill=\"#34d399\"/>",
  "handshake":
    "<path d=\"M1 9l5-5 6 3 4-2 7 6-5 9-5 2-8-7Z\" fill=\"#fb923c\"/><path d=\"M6 4l6 3-4 4 3 3 4-4 7 6 1-5-7-6-4 2Z\" fill=\"#facc15\"/><path d=\"M0 8l4-4 4 12-4 3Z\" fill=\"#38bdf8\"/><path d=\"M24 10l-4-4-4 12 4 3Z\" fill=\"#a78bfa\"/><path d=\"M9 16l5 4\" fill=\"none\" stroke=\"#f472b6\" stroke-width=\"1.5\"/>",
  "documents":
    "<path d=\"M5 2h9l5 5v15H5Z\" fill=\"#38bdf8\"/><path d=\"M14 2v6h5\" fill=\"#a78bfa\"/><path d=\"M14 2v6h5Z\" fill=\"#f472b6\"/><path d=\"M8 12h8M8 16h8M8 19h5\" fill=\"none\" stroke=\"#f8fafc\" stroke-width=\"1.8\"/>",
  "mail":
    "<rect x=\"1\" y=\"4\" width=\"22\" height=\"17\" rx=\"1.5\" fill=\"#38bdf8\"/><path d=\"M1 21l9-9h4l9 9Z\" fill=\"#a78bfa\"/><path d=\"M1 4h22L12 14Z\" fill=\"#f472b6\"/><circle cx=\"19\" cy=\"5\" r=\"4\" fill=\"#facc15\"/>",
  "markets":
    "<path d=\"M3 3v19h19\" fill=\"none\" stroke=\"#a78bfa\" stroke-width=\"2\"/><rect x=\"6\" y=\"15\" width=\"3\" height=\"5\" rx=\"0.5\" fill=\"#38bdf8\"/><rect x=\"11\" y=\"11\" width=\"3\" height=\"9\" rx=\"0.5\" fill=\"#22d3ee\"/><rect x=\"16\" y=\"7\" width=\"3\" height=\"13\" rx=\"0.5\" fill=\"#34d399\"/><path d=\"M6 11l5-5 4 2 6-6\" fill=\"none\" stroke=\"#facc15\" stroke-width=\"2\"/><path d=\"M17 1h6v6Z\" fill=\"#facc15\"/>",
  "bitcoin":
    "<circle cx=\"12\" cy=\"12\" r=\"11\" fill=\"#fb923c\"/><circle cx=\"12\" cy=\"12\" r=\"8\" fill=\"#facc15\"/><path d=\"M9 5v14M7 6h7a3 3 0 0 1 0 6H9m0 0h6a3 3 0 0 1 0 6H7M11 3v3M14 3v3M11 18v3M14 18v3\" fill=\"none\" stroke=\"#f8fafc\" stroke-width=\"1.6\"/><circle cx=\"4\" cy=\"12\" r=\"1\" fill=\"#f472b6\"/>",
  "wallet":
    "<rect x=\"2\" y=\"3\" width=\"18\" height=\"18\" rx=\"1.5\" fill=\"#a78bfa\"/><rect x=\"2\" y=\"6\" width=\"20\" height=\"16\" rx=\"1.5\" fill=\"#38bdf8\"/><rect x=\"15\" y=\"11\" width=\"8\" height=\"6\" rx=\"1.5\" fill=\"#f472b6\"/><circle cx=\"18\" cy=\"14\" r=\"1.5\" fill=\"#facc15\"/><path d=\"M5 9h8\" fill=\"none\" stroke=\"#f8fafc\" stroke-width=\"1.5\"/>",
  "credit":
    "<rect x=\"1\" y=\"4\" width=\"22\" height=\"17\" rx=\"3\" fill=\"#a78bfa\"/><rect x=\"1\" y=\"8\" width=\"22\" height=\"4\" rx=\"0\" fill=\"#38bdf8\"/><rect x=\"4\" y=\"15\" width=\"5\" height=\"3\" rx=\"1\" fill=\"#facc15\"/><circle cx=\"16\" cy=\"16\" r=\"2\" fill=\"#fb923c\"/><circle cx=\"19\" cy=\"16\" r=\"2\" fill=\"#f472b6\"/>",
  "savings":
    "<path d=\"M5 10l1-5 5 4h6l4 3h2v6h-3l-2 4h-4v-3H9v3H5l-1-5H1v-5h3Z\" fill=\"#f472b6\"/><path d=\"M14 19h-5v3H5l-1-5h16l-2 5h-4Z\" fill=\"#a78bfa\"/><circle cx=\"17\" cy=\"13\" r=\"1.3\" fill=\"#334155\"/><circle cx=\"11\" cy=\"4\" r=\"3\" fill=\"#facc15\"/><path d=\"M8 9h7\" fill=\"none\" stroke=\"#fb923c\" stroke-width=\"1.7\"/>",
  "receipt":
    "<path d=\"M4 1l4 2 4-2 4 2 4-2v22l-4-2-4 2-4-2-4 2Z\" fill=\"#38bdf8\"/><path d=\"M7 7h10M7 11h10\" fill=\"none\" stroke=\"#f8fafc\" stroke-width=\"1.7\"/><rect x=\"7\" y=\"15\" width=\"10\" height=\"5\" rx=\"1.5\" fill=\"#a78bfa\"/><path d=\"M9 17h6\" fill=\"none\" stroke=\"#facc15\" stroke-width=\"1.5\"/>",
  "analysis":
    "<path d=\"M2 2v20h21\" fill=\"none\" stroke=\"#a78bfa\" stroke-width=\"2\"/><rect x=\"5\" y=\"12\" width=\"4\" height=\"8\" rx=\"0.5\" fill=\"#38bdf8\"/><rect x=\"11\" y=\"6\" width=\"4\" height=\"14\" rx=\"0.5\" fill=\"#f472b6\"/><rect x=\"17\" y=\"10\" width=\"4\" height=\"10\" rx=\"0.5\" fill=\"#fb923c\"/><path d=\"M5 8l8-5 8 4\" fill=\"none\" stroke=\"#34d399\" stroke-width=\"2\"/>",
  "value":
    "<circle cx=\"12\" cy=\"12\" r=\"10\" fill=\"#34d399\"/><path d=\"M12 2a10 10 0 0 1 0 20Z\" fill=\"#22d3ee\"/><path d=\"M12 4v16M16 7h-6a3 3 0 0 0 0 6h4a3 3 0 0 1 0 6H7\" fill=\"none\" stroke=\"#facc15\" stroke-width=\"2\"/><path d=\"M2 1l4 5H0Z\" fill=\"#a78bfa\"/>",
  "video":
    "<rect x=\"1\" y=\"5\" width=\"15\" height=\"15\" rx=\"3\" fill=\"#a78bfa\"/><path d=\"M16 10l7-5v15l-7-5Z\" fill=\"#f472b6\"/><path d=\"M6 9l6 4-6 4Z\" fill=\"#facc15\"/><rect x=\"3\" y=\"3\" width=\"5\" height=\"3\" rx=\"1\" fill=\"#38bdf8\"/>",
  "camera":
    "<path d=\"M2 7h5l3-4h5l3 4h4v15H2Z\" fill=\"#a78bfa\"/><rect x=\"2\" y=\"10\" width=\"20\" height=\"12\" rx=\"1.5\" fill=\"#38bdf8\"/><circle cx=\"12\" cy=\"14\" r=\"6\" fill=\"#f472b6\"/><circle cx=\"12\" cy=\"14\" r=\"3\" fill=\"#334155\"/><circle cx=\"13\" cy=\"13\" r=\"1.2\" fill=\"#22d3ee\"/><rect x=\"18\" y=\"8\" width=\"3\" height=\"2\" rx=\"0.5\" fill=\"#facc15\"/>",
  "design":
    "<path d=\"M12 1a11 11 0 1 0 0 22h2a3 3 0 0 0 0-6h-1a2 2 0 0 1 0-4h6C26 13 22 1 12 1Z\" fill=\"#fb923c\"/><circle cx=\"7\" cy=\"7\" r=\"2\" fill=\"#38bdf8\"/><circle cx=\"13\" cy=\"5\" r=\"2\" fill=\"#f472b6\"/><circle cx=\"18\" cy=\"8\" r=\"2\" fill=\"#a78bfa\"/><circle cx=\"5\" cy=\"13\" r=\"2\" fill=\"#34d399\"/><circle cx=\"8\" cy=\"18\" r=\"2\" fill=\"#facc15\"/>",
  "audio":
    "<rect x=\"2\" y=\"8\" width=\"3\" height=\"8\" rx=\"1.5\" fill=\"#38bdf8\"/><rect x=\"6\" y=\"4\" width=\"3\" height=\"16\" rx=\"1.5\" fill=\"#a78bfa\"/><rect x=\"10\" y=\"1\" width=\"4\" height=\"22\" rx=\"1.5\" fill=\"#f472b6\"/><rect x=\"15\" y=\"5\" width=\"3\" height=\"14\" rx=\"1.5\" fill=\"#fb923c\"/><rect x=\"19\" y=\"9\" width=\"3\" height=\"6\" rx=\"1.5\" fill=\"#facc15\"/>",
  "writing":
    "<path d=\"M3 16L16 2l6 6L8 21l-6 1Z\" fill=\"#facc15\"/><path d=\"M12 6l6 6 4-4-6-6Z\" fill=\"#f472b6\"/><path d=\"M3 16l5 5-6 1Z\" fill=\"#a78bfa\"/><path d=\"M10 22h12\" fill=\"none\" stroke=\"#38bdf8\" stroke-width=\"2\"/>",
  "social":
    "<path d=\"M6 5l14 7-14 7\" fill=\"none\" stroke=\"#a78bfa\" stroke-width=\"2.5\"/><circle cx=\"6\" cy=\"5\" r=\"4\" fill=\"#38bdf8\"/><circle cx=\"20\" cy=\"12\" r=\"4\" fill=\"#f472b6\"/><circle cx=\"6\" cy=\"19\" r=\"4\" fill=\"#fb923c\"/><circle cx=\"6\" cy=\"4\" r=\"1.2\" fill=\"#f8fafc\"/><circle cx=\"20\" cy=\"11\" r=\"1.2\" fill=\"#facc15\"/>",
  "presentation":
    "<path d=\"M12 16v7M7 23l5-5 5 5\" fill=\"none\" stroke=\"#a78bfa\" stroke-width=\"2\"/><rect x=\"2\" y=\"2\" width=\"20\" height=\"15\" rx=\"1.5\" fill=\"#38bdf8\"/><rect x=\"1\" y=\"1\" width=\"22\" height=\"3\" rx=\"1.5\" fill=\"#a78bfa\"/><path d=\"M6 12l5-5 3 3 4-5\" fill=\"none\" stroke=\"#facc15\" stroke-width=\"2\"/><circle cx=\"18\" cy=\"5\" r=\"1.5\" fill=\"#f472b6\"/>",
  "smart-glasses":
    "<path d=\"M1 8h9l2 2 2-2h9v10H14v-6h-4v6H1Z\" fill=\"#a78bfa\"/><rect x=\"3\" y=\"10\" width=\"6\" height=\"6\" rx=\"1\" fill=\"#38bdf8\"/><rect x=\"15\" y=\"10\" width=\"6\" height=\"6\" rx=\"1\" fill=\"#f472b6\"/><path d=\"M2 8l3-6h3M22 8l-3-6h-3\" fill=\"none\" stroke=\"#fb923c\" stroke-width=\"2\"/><path d=\"M4 11l3 3M16 11l3 3\" fill=\"none\" stroke=\"#22d3ee\" stroke-width=\"1.3\"/>",
  "surf":
    "<circle cx=\"18\" cy=\"5\" r=\"4\" fill=\"#facc15\"/><path d=\"M7 16C7 9 12 3 16 2c2 7-1 13-6 17Z\" fill=\"#f472b6\"/><path d=\"M7 16C7 9 12 3 16 2L9 19Z\" fill=\"#fb923c\"/><path d=\"M0 17q3-5 6-1t6 0 6 0 6 0v8H0Z\" fill=\"#38bdf8\"/><path d=\"M1 21q3-4 6 0t6 0 6 0 6 0\" fill=\"none\" stroke=\"#22d3ee\" stroke-width=\"2\"/>",
  "coffee":
    "<path d=\"M15 7h4a4 4 0 0 1 0 8h-4\" fill=\"none\" stroke=\"#fb923c\" stroke-width=\"3\"/><path d=\"M2 6h14v10a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5Z\" fill=\"#f472b6\"/><path d=\"M2 6h7v15H7a5 5 0 0 1-5-5Z\" fill=\"#a78bfa\"/><path d=\"M5 1v2M11 1v2\" fill=\"none\" stroke=\"#facc15\" stroke-width=\"2\"/><path d=\"M1 23h19\" fill=\"none\" stroke=\"#38bdf8\" stroke-width=\"2\"/>",
  "dining":
    "<circle cx=\"12\" cy=\"13\" r=\"9\" fill=\"#38bdf8\"/><circle cx=\"12\" cy=\"13\" r=\"6\" fill=\"#a78bfa\"/><path d=\"M3 2v6a3 3 0 0 0 6 0V2M6 2v20\" fill=\"none\" stroke=\"#facc15\" stroke-width=\"2\"/><path d=\"M18 22V2c-5 2-5 10 0 10h3V2Z\" fill=\"#f472b6\"/><circle cx=\"12\" cy=\"13\" r=\"2\" fill=\"#fb923c\"/>",
  "live-music":
    "<path d=\"M8 5l14-4v6L8 11Z\" fill=\"#a78bfa\"/><path d=\"M9 7v12M21 4v12\" fill=\"none\" stroke=\"#f472b6\" stroke-width=\"2.5\"/><circle cx=\"5.5\" cy=\"19\" r=\"4\" fill=\"#38bdf8\"/><circle cx=\"17.5\" cy=\"16\" r=\"4\" fill=\"#fb923c\"/><circle cx=\"5\" cy=\"18\" r=\"1.2\" fill=\"#22d3ee\"/><circle cx=\"17\" cy=\"15\" r=\"1.2\" fill=\"#facc15\"/>",
  "comedy":
    "<path d=\"M1 2l11 3v8c0 6-8 9-11 2Z\" fill=\"#f472b6\"/><path d=\"M4 7h1M8 8h1M4 12q2 4 5 0\" fill=\"none\" stroke=\"#facc15\" stroke-width=\"1.7\"/><path d=\"M12 9l11-3v12c0 6-8 7-11 2Z\" fill=\"#a78bfa\"/><path d=\"M15 13h1M19 12h1M15 19q2-3 5-1\" fill=\"none\" stroke=\"#38bdf8\" stroke-width=\"1.7\"/>",
  "travel":
    "<path d=\"M9 5V1h6v4\" fill=\"none\" stroke=\"#a78bfa\" stroke-width=\"2\"/><rect x=\"3\" y=\"5\" width=\"18\" height=\"17\" rx=\"3\" fill=\"#38bdf8\"/><rect x=\"7\" y=\"5\" width=\"3\" height=\"17\" rx=\"0\" fill=\"#f472b6\"/><rect x=\"15\" y=\"5\" width=\"3\" height=\"17\" rx=\"0\" fill=\"#f472b6\"/><rect x=\"10\" y=\"11\" width=\"4\" height=\"4\" rx=\"1\" fill=\"#facc15\"/><circle cx=\"7\" cy=\"23\" r=\"1\" fill=\"#334155\"/><circle cx=\"17\" cy=\"23\" r=\"1\" fill=\"#334155\"/>",
  "home":
    "<path d=\"M4 10h16v13H4Z\" fill=\"#38bdf8\"/><path d=\"M0 11L12 1l12 10-2 2-10-8-10 8Z\" fill=\"#f472b6\"/><rect x=\"9\" y=\"14\" width=\"6\" height=\"9\" rx=\"1\" fill=\"#a78bfa\"/><rect x=\"5\" y=\"11\" width=\"4\" height=\"4\" rx=\"0.5\" fill=\"#facc15\"/><rect x=\"15\" y=\"11\" width=\"4\" height=\"4\" rx=\"0.5\" fill=\"#facc15\"/><circle cx=\"13\" cy=\"18\" r=\"0.7\" fill=\"#facc15\"/>",
  "health":
    "<path d=\"M12 23L2 13C-4 6 5-2 12 6c7-8 16 0 10 7Z\" fill=\"#f472b6\"/><path d=\"M12 6c7-8 16 0 10 7L12 23Z\" fill=\"#fb7185\"/><path d=\"M2 12h5l3-4 4 9 3-5h5\" fill=\"none\" stroke=\"#facc15\" stroke-width=\"2\"/>",
};
