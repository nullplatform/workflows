# Slack: triggers, messages, approvals & conversational agents

The Slack plugin family lets a workflow **start from Slack**, **post messages**,
**ask questions with buttons**, and **wait for a human's reply in a thread** —
enough to build a conversational agent that answers in a thread and loops until
it's done.

Everything is **client configuration**: one Slack app per workflow, two secrets
stored as [config entries](../concepts/config-entries.md), and the existing
webhook/trigger primitives. There is no OAuth, no marketplace, and no Slack
tables in the workflow database — an integration plugin never adds storage;
credentials live in config entries and inbound events ride the existing
webhook/trigger primitives.

| Plugin | Kind | What it does |
|---|---|---|
| [`slack-trigger`](#slack-trigger) | trigger | Start a workflow from a mention, message, reaction, or slash command; fan out thread replies as signals. |
| [`slack-send-message`](#slack-send-message) | module | Post a message to a channel or thread (`chat.postMessage`). |
| [`slack-ask`](#slack-ask) | module | Post a prompt with buttons and pause until someone clicks (or it times out). |
| [`slack-wait-message`](#slack-wait-message) | module | Pause until the next human reply lands in a thread. |

> Every Slack descriptor ships the same one-time setup walkthrough in its
> `documentation` field, which the canvas renders in a collapsible **Setup**
> section. This guide is the long-form version of that walkthrough plus the
> agent-loop pattern and troubleshooting.

---

## 1. One-time Slack app setup

You install **one Slack app per workflow** that talks to Slack. For a
conversational agent this is natural: the app *is* the agent — give it the
agent's name and avatar.

### 1.1 Create the app from the manifest

Go to <https://api.slack.com/apps> → **Create New App** → **From an app
manifest**, pick your workspace, and paste this manifest. Replace
`<YOUR APP NAME>`; leave the two request URLs as placeholders — you fill them
in at [step 1.4](#14-wire-the-urls-and-activate) once the workflow is activated.

```yaml
display_information:
  name: <YOUR APP NAME>
  description: Workflow automation
features:
  bot_user:
    display_name: <YOUR APP NAME>
    always_online: true
  slash_commands: []          # add /commands here if you use event: slash_command
oauth_config:
  scopes:
    bot:
      - chat:write            # post messages
      - chat:write.public     # post to channels the bot isn't a member of
      - app_mentions:read     # receive @mentions
      - channels:history      # read public-channel messages (thread replies)
      - groups:history        # read private-channel messages
      - im:history            # read direct messages
      - reactions:read        # receive reaction_added events
      - commands              # slash commands
settings:
  event_subscriptions:
    request_url: <TRIGGER WEBHOOK URL>   # runtimeMetadata.webhookUrl after activation
    bot_events:
      - app_mention
      - message.channels
      - message.groups
      - message.im
      - reaction_added
  interactivity:
    is_enabled: true
    request_url: <BASE>/workflows/webhooks/slack/interactivity
  org_deploy_enabled: false
  socket_mode_enabled: false
```

After the workflow is activated, `slack-trigger` publishes
`runtimeMetadata.manifestSnippet` — the same manifest with the real webhook URL
already substituted — so the canvas offers it as copy-paste.

### 1.2 Install and copy the credentials

- On the app's **Install App** page, click **Install to Workspace** and
  approve. Copy the **Bot User OAuth Token** (`xoxb-…`).
- On **Basic Information → App Credentials**, copy the **Signing Secret**.

### 1.3 Store both as config entries (secrets)

The token and secret are **secrets** — never put them in YAML. Store them as
config entries (redacted, write-only, per-org, scoped to a folder or workflow),
then reference them from config with `${{ secrets.NAME }}`. The names are a
convention — reference whatever you pick.

- `SLACK_BOT_TOKEN` → used by `slack-send-message` / `slack-ask` as
  `${{ secrets.SLACK_BOT_TOKEN }}`
- `SLACK_SIGNING_SECRET` → used by `slack-trigger` and the interactivity route
  as `${{ secrets.SLACK_SIGNING_SECRET }}`

Create them with the editor's **Secrets** panel, or with the config-entries API
(`POST /workflows/config`, see [Config Entries](../concepts/config-entries.md)),
using **your** session bearer:

```bash
# Folder-scoped so every workflow under /agents sees them:
curl -sf -X POST "$ENGINE/workflows/config" \
  -H "Authorization: Bearer $NP_SESSION_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"SLACK_BOT_TOKEN","value":"'"$SLACK_BOT_TOKEN"'","secret":true,"path":"/agents"}'

curl -sf -X POST "$ENGINE/workflows/config" \
  -H "Authorization: Bearer $NP_SESSION_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"SLACK_SIGNING_SECRET","value":"'"$SLACK_SIGNING_SECRET"'","secret":true,"path":"/agents"}'
```

Use `"workflow":"<wf_id>"` instead of `"path"` to scope to a single workflow.
Precedence is workflow → deepest folder → `/`.

### 1.4 Wire the URLs and activate

Publish and activate the workflow. If it has a `slack-trigger`, its webhook URL
appears in the trigger node's **Setup → Webhook URL**
(`runtimeMetadata.webhookUrl`). Then, back in the Slack app config:

1. **Event Subscriptions → Request URL** = the trigger's webhook URL. Slack
   immediately sends a one-time `url_verification` challenge; the trigger
   answers it (you'll see the URL go green). Point each slash command's URL at
   the same webhook URL.
2. **Interactivity & Shortcuts → Request URL** =
   `<BASE>/workflows/webhooks/slack/interactivity` (a single deployment-fixed
   route, used by `slack-ask` buttons — [§4](#4-slack-ask)). This URL must be
   **publicly reachable** by Slack.

Activation is atomic: saving a workflow has no side effects; only activating an
alias registers the trigger's webhook.

---

## 2. `slack-trigger`

Starts a workflow when your app receives an **@mention**, a **channel/DM
message**, a **reaction**, or a **slash command**. Independently, it fans out
every thread reply as a `slack-message` signal so a
[`slack-wait-message`](#slack-wait-message) step in the same workflow can resume
the conversation — this is what powers the [agent loop](#5-the-agent-loop-pattern).

```yaml
- id: on_mention
  type: trigger
  plugin_type: slack-trigger
  config:
    event: mention                      # mention | message | reaction | slash_command
    signingSecret: "${{ secrets.SLACK_SIGNING_SECRET }}"
    # channel: C0123ABCDEF              # optional id filter (recommended for `message`)
    # pattern: "^deploy .*"             # optional regex on the text (mention/message)
    # command: /deploy                  # REQUIRED when event: slash_command
    # reaction: white_check_mark        # REQUIRED when event: reaction
    # include_thread_replies: false     # message mode: also START on thread replies
```

**Config fields** (exact names): `event`, `signingSecret`, `channel`,
`pattern`, `command`, `reaction`, `include_thread_replies`. `command` is
required for `slash_command`; `reaction` is required for `reaction`.

**Outputs → workflow inputs.** When the trigger starts an execution, its outputs
*become the workflow inputs*, so downstream steps read `${{ workflow.inputs.X }}`:

| Output | Notes |
|---|---|
| `event` | `app_mention` / `message` / `reaction_added` / `slash_command` |
| `text` | message or command text |
| `user` | author's Slack user id |
| `channel` | channel id |
| `ts` | message timestamp |
| `thread_ts` | thread root (falls back to `ts` for a top-level message) |
| `team_id` | workspace/team id |
| `reaction` | emoji name (reaction events only) |
| `command`, `command_text` | slash-command events only |

`team_id`, `channel`, and `thread_ts` are exactly the three ids
`slack-wait-message` needs to correlate a reply.

> `include_thread_replies` only controls whether a thread reply also *starts a
> new execution*. Thread replies are **always** fanned out as `slack-message`
> signals regardless of this flag — that's how the wait step resumes.

---

## 3. `slack-send-message`

Posts a message with `chat.postMessage`. `executeMode: 'each'`, and step
`inputs:` override config (loop-friendly).

```yaml
- id: notify
  type: module
  plugin_type: slack-send-message
  config:
    channel: "#deploys"                          # id (C…) or #name
    message: "Deploy of *${{ workflow.inputs.service }}* starting :rocket:"
    # blocks: [ ... ]                            # Block Kit; takes precedence over `message`
    # thread_ts: "${{ steps.notify.outputs.ts }}"  # reply in a thread
    # unfurl_links: false
    botToken: "${{ secrets.SLACK_BOT_TOKEN }}"
```

**Config fields**: `channel`, `message`, `blocks`, `thread_ts`, `unfurl_links`,
`botToken`. Provide either `message` (mrkdwn) or `blocks`. `channel` may be
supplied per item at run time.

**Outputs**: `{ ok, channel, ts }`. Pass `ts` as a later step's `thread_ts` to
reply in the same thread, or as `slack-wait-message`'s `thread_ts` to wait on
the thread you just opened.

---

## 4. `slack-ask`

Posts a prompt with up to 25 buttons and **pauses the workflow** until someone
clicks one (or it times out). Replaces the old `slack-approve` with generic
buttons — branch on the returned `value`. When it resolves, the message updates
in place to show who answered. This is the reference **two-phase wait** plugin:
it does its side effect (posting the prompt) and then pauses, resuming when the
click arrives.

```yaml
- id: approve
  type: module
  plugin_type: slack-ask
  config:
    channel: "#deploys"
    prompt: "Deploy *${{ workflow.inputs.version }}* to production?"
    buttons:
      - { label: "Ship it", value: approve, style: primary }
      - { label: "Abort",   value: reject,  style: danger }
    # thread_ts: "${{ steps.notify.outputs.ts }}"   # optional
    timeout: "24h"
    onTimeout: error            # error (default) | continue
    botToken: "${{ secrets.SLACK_BOT_TOKEN }}"
```

**Config fields**: `channel`, `prompt`, `buttons[{label, value, style}]`,
`thread_ts`, `timeout`, `onTimeout`, `botToken`. `style` is `primary` (green),
`danger` (red), or default (grey).

**Ports**: `default` (a button was clicked) and `timeout`.
**Outputs**: `{ value, label, user_id, user_name, ts, channel, timedOut }` —
`value`/`label` come from the clicked button.

Requires the app's **Interactivity Request URL** to be wired to
`<BASE>/workflows/webhooks/slack/interactivity` ([§1.4](#14-wire-the-urls-and-activate)).
Clicks land on that one fixed route; the capability to resume the exact waiting
step travels **inside the button** (an opaque `executionId|signalId|value`
codec), so no lookup table is needed — a workflow using `slack-ask` doesn't even
need a `slack-trigger`.

---

## 5. `slack-wait-message`

Pauses until the next human reply lands in a Slack thread. It's sugar over
`signal-wait`: it computes the correlation key
`slack:<team_id>:<channel>:<thread_ts>` and waits on the `slack-message` signal
that `slack-trigger` fans out for thread replies. Like `signal-wait`, it runs
**inline in the workflow sandbox** (zero I/O), so it works identically on the
local and hosted runtimes.

```yaml
- id: wait_reply
  type: module
  plugin_type: slack-wait-message
  join_strategy: any            # when used on a loop node — see §6
  config:
    team_id: "${{ workflow.inputs.team_id }}"
    channel: "${{ workflow.inputs.channel }}"
    thread_ts: "${{ workflow.inputs.thread_ts }}"
    timeout: "2h"
    onTimeout: continue         # error (default) | continue
```

**Config fields**: `team_id`, `channel`, `thread_ts` (all required), `timeout`,
`onTimeout`. All three ids come straight from the trigger outputs (i.e.
`workflow.inputs.*`) or a send step's outputs.

**Ports**: `default` (a reply arrived) and `timeout`.
**Outputs**: `{ text, user, ts, thread_ts, channel, timedOut }`.

> **It only works in a workflow whose Slack app has a `slack-trigger`** receiving
> `message.*` events — that trigger is the only thing that fans out the
> `slack-message` signal. The fan-out reaches waits **in the trigger's own
> workflow** (which is exactly the agent-loop case); cross-workflow
> correlation-only routing is out of scope.

### Timeout semantics (both wait plugins)

Both `slack-wait-message` and `slack-ask` default `onTimeout` to **`error`**
(the step fails when nobody responds). Set `onTimeout: continue` to activate the
`timeout` port and keep going instead.

The mechanism differs by design:

- **`slack-wait-message`** passes your `onTimeout` straight to the inline wait —
  `error` fails the step; `continue` resumes on the `timeout` port.
- **`slack-ask`** always arms its internal wait with `onTimeout: 'continue'` so
  it can run its phase-2 `chat.update` (marking the message `⏰ expired`) *even
  on timeout*, and only then applies *your* `onTimeout`: `error` fails the step,
  `continue` takes the `timeout` port. So the user-facing default is the same;
  `slack-ask` just always gets to update the message first.

---

## 6. The agent-loop pattern

The north-star: a Slack app that behaves like a person in a thread. Someone
@mentions the bot, Claude answers, and the workflow waits for the human's reply
and **resumes the same Claude session** — looping until the agent decides it's
done.

```
slack-trigger (@mention)
  → set-variable  (stash the message → variables.current_message)
  → claude-code-agent  (conversationId fixed, resumeSession, outputSchema {reply, done})
  → conditional (done?)
      false → slack-send-message (reply in thread)
                → slack-wait-message (human reply)
                  → set-variable (stash the reply) ─┐
      true  → slack-send-message (final reply)       │
  ▲ ──────────────── back-edge (reentry) into agent ─┘
```

The full pattern is a Slack agent demo workflow with an E2E test alongside it.
Three things make the loop correct — all covered in
[Loops and Streaming](../concepts/loops-and-streaming.md):

1. **`join_strategy: any` on the looped node.** The agent has two incoming
   edges (the first-turn path and the reentry back-edge). The default `all` join
   deadlocks waiting on the back-edge that only fires after turn 1.
2. **The accumulator pattern carries the message across the loop.** A reentry
   node with two live predecessors sees *both* predecessors' items in `$items`
   (join semantics), so `$item` is ambiguous on the loop. Each entry path gets
   its own single-predecessor `set-variable` that writes the incoming text into
   `variables.current_message`, and the agent reads **that variable** — never
   `$item`. This mirrors the
   [streaming-pagination accumulator](../concepts/loops-and-streaming.md#streaming-pagination-pattern).
3. **Stable ids from `workflow.inputs.*`.** `channel` / `thread_ts` / `team_id`
   come from the trigger (whose outputs became the workflow inputs) and stay
   constant across every turn, so `slack-send-message` and `slack-wait-message`
   always target the same thread.

### Resumable Claude sessions

The agent step sets `resumeSession: true` with a fixed `conversationId`. On the
E2B runner this **pauses** the sandbox (filesystem + memory frozen) between
turns and resumes it on the next turn, so `claude --resume` continues the full
transcript without ever storing it in workflow state or the hosted runtime's
history — only a compact `{lastSessionId, sandboxId, cappedExchangeLog}` lives in
`nodeContext`. See the `claude-code-agent` descriptor's `resumeSession` field.
The in-process runner ignores `resumeSession` (its `~/.claude` already persists
on the worker host). If a paused sandbox is purged, the agent degrades to a
fresh session and never fails the step for a lost VM.

The agent declares the `outputSchema` `{ reply, done }`; the `conditional` step
branches on `$item.done` to either post a final reply (`true`) or send the reply
and wait for the next human message (`false`).

---

## 7. Troubleshooting

**URL verification fails when you paste the webhook URL.**
Slack sends a one-time `url_verification` challenge, which the trigger answers
*only after the request signature passes*. Make sure `SLACK_SIGNING_SECRET` is
stored as a config entry visible at the workflow's scope and referenced as
`${{ secrets.SLACK_SIGNING_SECRET }}`. A wrong/missing secret returns 401 and
Slack reports the URL as unverified.

**Signature failures (401).**
The v0 HMAC is computed over the exact raw request bytes as
`v0:{timestamp}:{body}`. Requests older than 5 minutes are rejected (replay
protection) — check the app and server clocks. If a reverse proxy re-encodes or
buffers the body, the raw bytes won't match; pass Slack's request through
untouched. The interactivity route resolves the *same* signing secret from the
config entry visible at the target execution's workflow scope, so an ask in a
workflow with no `SLACK_SIGNING_SECRET` entry returns 401.

**Events arrive several times.**
Slack retries any delivery it doesn't get a `200` for within ~3s — and a retry
may land on a DIFFERENT API replica. Dedupe is two layers: an in-process
`event_id` LRU (fast path), and the storage-backed **idempotent start** (the
truth): the trigger stamps `idempotencyKey: slack:<team_id>:<event_id>` on the
dispatch, and the executions table enforces one execution per
`(workflow, key)` — every duplicate, on any replica, collapses into the same
execution. The key is visible on the execution record (API and canvas), so a
"missing" run for a retry is traceable to the run it deduped into.

**The bot answers its own messages (a loop).**
The trigger drops events with a `bot_id`, `subtype: bot_message`,
`message_changed`/`message_deleted`, and any message whose author is the app's
own bot user. Always post agent replies with `slack-send-message` (a bot token)
so they carry a `bot_id` and never re-trigger.

**`CONFIG_ENTRY` / missing secret.**
`SLACK_MISSING_TOKEN` (send/ask) or a 401 from the trigger means the referenced
config entry isn't resolvable at that scope. Confirm the entry exists
(`GET /workflows/config?workflow=<id>&ancestors=true`) and that the reference
name matches. Secrets never fall back to environment variables.

**A button click does nothing.**
Check the app's **Interactivity Request URL** is
`<BASE>/workflows/webhooks/slack/interactivity` and publicly reachable. A
malformed button value returns 400; an unknown execution returns 404.

**The wait never resumes.**
`slack-wait-message` only resumes on the `slack-message` signal, which only the
`slack-trigger` fans out. The workflow must have a `slack-trigger` receiving
`message.*` events, and the `team_id`/`channel`/`thread_ts` must match the
thread the human replied in. On timeout, remember the default is `onTimeout:
error` — set `continue` if you want the `timeout` port instead.

---

## See also

- [Config Entries: Secrets & Variables](../concepts/config-entries.md)
- [Loops and Streaming](../concepts/loops-and-streaming.md) — the reentry loop the agent uses
- [Agents](./agents.md) — the `claude-code-agent` step, resumable sessions, and tools
- [nullplatform Integration](./nullplatform-integration.md)
