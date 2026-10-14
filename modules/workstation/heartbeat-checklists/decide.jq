# One gateway's heartbeats against their Nix checklists
# (openclaw-heartbeat-checklists.nix). Pure; the caller makes the RPCs.
#
#   --arg phase ticking  ids of the heartbeat jobs that tick
#   --arg phase verdict  one entry per ticking heartbeat: status, the text to
#                        write and, unless it matches, a fleet-health finding
#   --arg inst           instance name, for the findings
#
# stdin: {cron: cron.status, jobs: [heartbeat jobs from every cron.list page],
#   agents: agents.list, scratch: {jobId: cron.scratch.get reply},
#   checklists: {workspace dir: {source, content}}}
. as {cron: $cron, jobs: $jobs, agents: $agents, scratch: $scratch, checklists: $checklists}
| def heartbeats: [($jobs // [])[] | select(.payload.kind == "heartbeat")];
  # A disabled job never ticks, and no job does while the scheduler is off
  # (studio sets cron.enabled = false).
  def ticking:
    if ($cron.enabled // false) == true
    then [heartbeats[] | select(.enabled == true)]
    else []
    end;
  def cadence:
    if .schedule.kind == "every" then "every \(.schedule.everyMs / 60000 | floor)m"
    elif .schedule.kind == "cron" then "on \(.schedule.expr)"
    else "on its schedule"
    end;

  if $phase == "ticking" then
    [ticking[] | .id]
  else
    ([heartbeats[] | .agentId] | group_by(.) | map(select(length > 1) | .[0])) as $dupes
    | ([($agents.agents // [])[] | {key: .id, value: .workspace}] | from_entries) as $workspaces
    | [ticking[]
      | . as $job
      | ($workspaces[.agentId] // null) as $workspace
      | (if $workspace == null then null else ($checklists // {})[$workspace] end) as $declared
      | (($scratch // {})[.id] // null) as $reply
      | (if ($dupes | index($job.agentId)) != null then "duplicate"
         elif ($reply | type) != "object" or ($reply | has("currentRevision") | not) then "unread"
         elif $declared == null then (if $reply.scratch == null then "generic" else "undeclared" end)
         elif $reply.scratch == null then "missing"
         elif $reply.scratch.content == $declared.content then "match"
         else "drift"
         end) as $status
      | {
          id,
          agentId,
          status: $status,
          workspace: $workspace,
          source: ($declared.source // null),
          want: ($declared.content // null),
          current: ($reply.scratch.content? // null),
          revision: ($reply.currentRevision? // null),
          finding: (
            if $status == "drift" then
              "\($inst): \(.agentId)'s heartbeat checklist is not its Nix file (scratch rev \($reply.currentRevision), changed \($reply.scratch.updatedAtMs / 1000 | floor | todate)); the next gateway start puts the Nix file back, so make a lasting change in its HEARTBEAT.md source"
            elif $status == "missing" then
              "\($inst): \(.agentId)'s Nix heartbeat checklist was never written (no scratch, so each tick runs the generic prompt); systemctl --user restart openclaw-\($inst)-heartbeat-checklists"
            elif $status == "generic" then
              "\($inst): \(.agentId)'s heartbeat ticks \($job | cadence) with no checklist, so each tick is a model turn on the generic prompt; give \($workspace // "its workspace") a Nix HEARTBEAT.md or disable the heartbeat"
            elif $status == "duplicate" then
              "\($inst): \(.agentId) has more than one heartbeat job, so its checklist is ambiguous"
            elif $status == "unread" then
              "\($inst): \(.agentId)'s heartbeat scratch could not be read"
            else null
            end
          )
        }]
  end
