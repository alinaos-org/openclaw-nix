// openclaw-session-icons — the Icon library in the session menu.
//
// Browser-only: dist/control-ui/library.js saves a choice through the gateway's
// own sessions.patch, so the plugin registers no methods, hooks or tools.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "session-icons",
  name: "Session Icons",
  description: "A searchable library of colour session icons, from the session menu.",
  register() {},
});
