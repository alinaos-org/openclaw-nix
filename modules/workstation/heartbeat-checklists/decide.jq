# One gateway's heartbeats against their Nix checklists
# (openclaw-heartbeat-checklists.nix). Pure; the caller makes the RPCs.
#
#   --arg phase page      stdin is one cron.list page: its heartbeat jobs,
#                         projected to the fields the other phases read
#   --arg phase ticking   ids of the heartbeat jobs that tick
#   --arg phase declared  fleet-health findings where the ticking set is not
#                         the one Nix declares (none when it declares nothing)
#   --arg phase verdict   one entry per ticking heartbeat: status, the text to
#                         write and, unless it matches, a fleet-health finding
#   --arg inst            instance name, for the findings
#
# stdin (all but page): {cron: cron.status, jobs: [page output of every cron.list
#   page], agents: agents.list, scratch: {jobId: cron.scratch.get reply},
#   checklists: {workspace dir: {source, content}},
#   declared: [agent ids Nix declares ticking] or null}
#
# A heartbeat is a 2026.11.4 heartbeat job (payload kind "heartbeat") or what
# 2026.11.5's doctor turns it into: an ordinary agentTurn job with
# skipIfScratchEmpty and no declarationKey, still named heartbeat-<agent>, or
# the "Proactive check (<agent>)" it creates for an agent that only had a
# HEARTBEAT.md.
def proactiveCheck:
  .payload.kind == "heartbeat"
  or (.payload.kind == "agentTurn"
    and .payload.skipIfScratchEmpty == true
    and (.declarationKey // null) == null
    and (.name == ("heartbeat-" + (.agentId // ""))
      or .name == ("Proactive check (" + (.agentId // "") + ")")));
def cadence:
  if .schedule.kind == "every" then "every \(.schedule.everyMs / 60000 | floor)m"
  elif .schedule.kind == "cron" then "on \(.schedule.expr)"
  else "on its schedule"
  end;

if $phase == "page" then
  [(.jobs // [])[]
    | select(proactiveCheck)
    | {id, agentId, name, declarationKey, enabled, schedule,
       payload: {kind: .payload.kind, skipIfScratchEmpty: .payload.skipIfScratchEmpty}}]
else
. as {cron: $cron, jobs: $jobs, agents: $agents, scratch: $scratch, checklists: $checklists, declared: $declared}
| def heartbeats: [($jobs // [])[] | select(proactiveCheck)];
  # A disabled job never ticks, and no job does while the scheduler is off
  # (studio sets cron.enabled = false).
  def ticking:
    if ($cron.enabled // false) == true
    then [heartbeats[] | select(.enabled == true)]
    else []
    end;

  if $phase == "ticking" then
    [ticking[] | .id]
  elif $phase == "declared" then
    if $declared == null or ($cron.enabled // false) != true then []
    else
      [ticking[] | select(.agentId as $a | $declared | index($a) | not)
        | "\($inst): \(.agentId)'s proactive check ticks \(cadence) but Nix declares it off"]
      + [([ticking[] | .agentId]) as $on | $declared[] | select(. as $a | $on | index($a) | not)
        | "\($inst): \(.) is declared to tick but has no enabled proactive check"]
    end
  else
    ([heartbeats[] | .agentId] | group_by(.) | map(select(length > 1) | .[0])) as $dupes
    | ([($agents.agents // [])[] | {key: .id, value: .workspace}] | from_entries) as $workspaces
    | [ticking[]
      | . as $job
      | ($workspaces[.agentId] // null) as $workspace
      | (if $workspace == null then null else ($checklists // {})[$workspace] end) as $declaredFile
      | (($scratch // {})[.id] // null) as $reply
      | (if ($dupes | index($job.agentId)) != null then "duplicate"
         elif ($reply | type) != "object" or ($reply | has("currentRevision") | not) then "unread"
         elif $declaredFile == null then (if $reply.scratch == null then "generic" else "undeclared" end)
         elif $reply.scratch == null then "missing"
         elif $reply.scratch.content == $declaredFile.content then "match"
         else "drift"
         end) as $status
      | {
          id,
          agentId,
          status: $status,
          workspace: $workspace,
          source: ($declaredFile.source // null),
          want: ($declaredFile.content // null),
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
end
