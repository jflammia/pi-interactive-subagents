# pi-interactive-subagents

Async subagents for [pi](https://github.com/badlogic/pi-mono), running in [herdr](https://herdr.dev) panes. Spawn a sub-agent, keep working in the main session, and get the result steered back when it finishes. Fully non-blocking.

**herdr-only.** Fork of [amosblomqvist/pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents)
— see [Why this fork](#why-this-fork).

## What this version does

Everything below is how sub-agents behave in this extension.

- **Every sub-agent pane is named after the sub-agent.** No hunting through
  anonymous panes to work out which one is the reviewer.
- **Panes tile into a grid and stay even.** Each spawn splits the largest pane
  the extension owns, across that pane's long axis, and a pass afterwards sets
  the split ratios so the panes come out uniform — six sub-agents land as an
  exact 3x2. Closing one re-tiles the rest. `MIN_COLS` / `MIN_ROWS` decide when
  another column would be too narrow and a row is used instead. There is
  nothing to configure.
- **An agent can run in a dedicated tab instead of pi's window.** Set
  `pane-placement: tab` in its definition and its panes tile in their own tab,
  leaving your working window full-size. Mixed placements run side by side, and
  the tab cleans itself up when the last sub-agent exits.
- **herdr shows what each sub-agent is doing.** Panes report `working`,
  `idle` and `unknown` as they run, so herdr's sidebar, notifications,
  `agent list` and `agent wait` agree with the status widget — background work
  is visible without switching to the pane.
- **Each pane opens in the sub-agent's working directory.** herdr is told the
  cwd when the pane is created, so the shell is already there — nothing is
  prefixed onto the launch command, and the pane is usable as-is if you take it
  over.
- **Names are predictable.** A sub-agent's name is normalized once to
  `[a-z][a-z0-9_-]{0,31}` and that one string is the widget row, the pane
  label, the herdr agent label and the generated filenames.
- **Sub-agents stay sandboxed.** They launch with `--no-extensions` and an
  explicit tool allowlist, and nothing about the herdr integration widens that
  — state is reported by the parent, so herdr never learns a session it could
  relaunch unsandboxed. See [herdr agent state](#herdr-agent-state).

Requires [herdr](https://herdr.dev); pi must be running in a herdr pane.

## Why this fork

Upstream is tmux-only. This fork targets [herdr](https://herdr.dev), a terminal
workspace manager built for running coding agents — its panes can be named, its
splits can be sized numerically, and it tracks agent lifecycle state, which is
what the behaviour above is built on. The swap sits at upstream's own seam:
`index.ts` makes no multiplexer calls, importing nine functions from `herdr.ts`.
Everything above that file — the async spawn/steer model, the sandboxed tool
allowlist, session modes, the status widget — is upstream's work, unchanged.

## How it works

`subagent()` returns immediately. The sub-agent runs in its own herdr pane, created with `--no-focus` so it never steals keyboard focus. A live widget above the input tracks every running sub-agent, and when one finishes, its result is steered into the main session as a notification that triggers a new turn.

```
╭─ Subagents ──────────────────────────── 2 running ─╮
│ 00:23  scout      active · bash 7m                 │
│ 00:45  scout-2    waiting 2m                       │
╰────────────────────────────────────────────────────╯
```

Spawn several in parallel — they run concurrently and steer results back independently as each finishes.

Panes are tiled into a grid and kept evenly sized. A split divides the *target pane's* real estate rather than the whole window, so each spawn splits the largest pane the extension owns, across that pane's long axis — adding a row once another column would fall below `MIN_COLS`. After every spawn and exit a debounced pass sets each split's ratio so the panes come out uniform (6 sub-agents tile to an exact 3x2), which also re-tiles the survivors when one exits. The floors are `MIN_COLS` / `MIN_ROWS` in `pi-extension/subagents/herdr.ts`.

Agents that should stay out of the way run in a **dedicated subagent tab** instead of splitting pi's window — set `pane-placement: tab` in the agent definition. The first such sub-agent takes the new tab's root pane and the rest tile inside it; herdr removes the tab on its own once the last one exits. The two placements can be mixed, and each tab is balanced against its own panes.

Quitting pi leaves its sub-agent panes standing — they are separate panes — and
a herdr server restart restores them. A new pi run adopts the existing
`subagents` tab in its workspace rather than opening a second one; its leftover
panes are not tracked as ours, so tiling treats them as the user's and works
around them.

If your shell startup is slow and launch commands get dropped before the prompt is ready, raise the delay:

```bash
export PI_SUBAGENT_SHELL_READY_DELAY_MS=2500   # default: 500
```

## Tools

| Tool | Description |
| --- | --- |
| `subagent` | Spawn a sub-agent in a dedicated herdr pane (async) |
| `subagent_message` | Message a sub-agent by name — steers it if running, resumes its session if finished |
| `subagents_list` | List available agent definitions |
| `ask_question` | *(sub-agent sessions only)* Ask the orchestrator a question and wait for the reply |

There is also a `/subagent <agent> <task>` command for spawning directly.

### Spawning

```typescript
subagent({ agent: "scout", task: "Analyze the auth module" });
subagent({ agent: "worker", name: "dark-mode", task: "Implement the dark mode toggle" });
```

| Parameter | Type | Default | Description |
| --------- | ---- | ------- | ----------- |
| `agent` | string | required | Which agent to spawn (must be known and permitted) |
| `task` | string | required | Task prompt |
| `name` | string | agent name | Display name for the pane and widget. Must be unique — duplicates are auto-suffixed (`scout`, `scout-2`, …) |
| `model` | string | agent's model | Override the model for this spawn |
| `cwd` | string | agent's `cwd` | Working directory (see [Role folders](#role-folders)) |

### Messaging

`subagent_message` is addressed **by name only**. Names are unique per session and persist after a sub-agent finishes, so the same name works either way:

```typescript
subagent_message({ name: "scout", message: "Also check the auth middleware" });
```

- **Running** — the message is typed into the live pane (newlines flattened) and picked up at the next turn boundary. The call returns immediately; the eventual completion still arrives as a steer message.
- **Finished** — the session is resumed with the message as the follow-up task, like a fresh spawn: fire-and-forget, always autonomous, result steered back later. The resumed run reclaims its original name.

Every spawn records name → session file in `artifacts/<sessionId>/subagent-registry.json`, so names stay addressable across pi restarts. A nested sub-agent that spawns children gets its own registry keyed by its own session id. Resume is refused with a clear error (listing known names) if the name isn't registered, the session file is gone, or the session predates sandboxed resume.

**Resume replays the original sandbox.** At spawn time the fully-resolved loadout — tool allowlist, backing extensions, model, thinking level, system prompt, spawn whitelist, cwd — is snapshotted to `<session>.loadout.json`. Resume rebuilds the exact same restricted process from that snapshot rather than relaunching unrestricted.

### ask_question

A sub-agent can ask its orchestrator a single freeform question when requirements are ambiguous or a decision materially affects the work. The session **stays open** (parked as `waiting`) instead of exiting; the parent is notified with the sub-agent's name, replies via `subagent_message({ name, message })`, and the reply arrives as the sub-agent's next turn. Parallel questions are supported — each waiting sub-agent has its own name.

If the reply arrives while the sub-agent is still mid-turn, it is absorbed into the current turn — either way the question is marked answered and the session exits normally when the work is done. If the parent never replies, the pane stays open until a human closes it. Only available inside sub-agent sessions.

## Bundled agents

| Agent | Model | Tools | Role |
| ----- | ----- | ----- | ---- |
| **scout** | `openrouter/z-ai/glm-5.3` | `read`, `grep`, `find`, `ls` | Fast read-only codebase recon |
| **researcher** | `openrouter/z-ai/glm-5.3` | `web_search`, `web_fetch`, `safe_bash` | Web research, synthesized into a sourced brief |
| **worker** | `openrouter/z-ai/glm-5.3` | `read`, `write`, `edit`, `bash`, `web_search`, `web_fetch` + spawning | General implementer; may spawn `scout` and `researcher` |

All three are autonomous (`auto-exit: true`) and carry their identity in the system prompt (`system-prompt: append`).

## Custom agents

Place a `.md` file in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global). Discovery priority: **project > global > package-bundled** — a project-local file overrides a bundled agent with the same name.

```markdown
---
name: my-agent
description: Does something specific
model: openrouter/z-ai/glm-5.3
thinking: medium
tools: read, edit, write, safe_bash, web_search
session-mode: lineage-only
auto-exit: true
---

You are a specialized agent that does X...
```

### Frontmatter reference

| Field | Type | Description |
| ----- | ---- | ----------- |
| `name` | string | Agent name (used in `agent: "my-agent"`) |
| `description` | string | Shown in `subagents_list` |
| `model` | string | Default model |
| `thinking` | string | `minimal`, `low`, `medium`, or `high` |
| `tools` | string | Strict tool allowlist. Built-ins: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`. Extension-backed: `web_search`, `web_fetch`, `safe_bash`, `video_extract`, `youtube_search`, `google_image_search`. Only the extensions backing the listed tools are loaded into the child |
| `subagent_agents` | string | Comma-separated agent names this agent may spawn. **Presence of this field grants the spawning toolset** (`subagent`, `subagent_message`, `subagents_list`) and restricts spawn targets to the list. Omit it and the agent cannot spawn at all |
| `skills` | string | Comma-separated skill names to auto-load |
| `session-mode` | string | `standalone` (default), `lineage-only`, or `fork` — see below |
| `system-prompt` | string | `append` or `replace`: pass the body as the child's `--append-system-prompt` / `--system-prompt`. Omit and the body is prepended to the task prompt instead |
| `auto-exit` | boolean | Auto-shutdown when the agent finishes (see below) |
| `interactive` | boolean | Whether stall/recovery transitions wake the parent (see below) |
| `pane-placement` | string | `split` (default) tiles the pane in pi's tab; `tab` puts it in a dedicated subagent tab, leaving pi's window full-size |
| `cwd` | string | Default working directory |
| `disable-model-invocation` | boolean | Hide from `subagents_list`; still spawnable by explicit name |
| `cli` | string | `claude` runs the agent via the Claude Code CLI instead of pi |

### session-mode

- `standalone` — fresh session, no lineage link to the caller (default)
- `lineage-only` — fresh session with `parentSession` linkage for discovery/fork UX, but no copied turns
- `fork` — child session seeded with the caller's conversation context

### auto-exit

With `auto-exit: true`, the session shuts down when the agent's turn ends — the agent just writes its final message and stops (there is no "done" tool). The last assistant message becomes the summary returned to the parent. Recommended for all autonomous agents.

Notes:

- **Manual input does not strand an auto-exit sub-agent.** If a human types into the pane, the session still closes once that turn completes normally — only an escape/abort leaves it open.
- **Auto-exit is suppressed while work is in flight:** the session parks as `waiting` instead of exiting when an `ask_question` is still unanswered, or when the agent's own child sub-agents are still running (a worker can stop after dispatching children and stays open until the last result returns).

### interactive

Controls whether `stalled`/`recovered` status transitions send a steer message to the parent session. Defaults to the inverse of `auto-exit`: autonomous agents get stall pings; user-driven agents stay quiet (the user is already working in that pane — the widget still updates). Set explicitly to override.

## Tool access control

Access is **whitelist-only**. Every sub-agent process is launched with `--no-extensions` (extension discovery disabled) and `--tools <allowlist>`; only the extensions backing the listed tools are loaded back in explicitly. There is no default toolset and no deny-list — an agent gets exactly what its frontmatter lists. The restriction survives resume via the loadout snapshot.

Spawns must name a known agent at **every** depth. A top-level session may spawn anything discoverable; a sub-agent may only spawn the agents in its `subagent_agents` list (enforced via `PI_SUBAGENT_ALLOWED`). There is no agentless spawn route, so a child can never escalate to a full-toolset profile by omitting its agent.

Extensions can register additional tools for sub-agents at runtime via `registerToolExtension(name, path)` on the `__pi_interactive_subagents` process global.

## Role folders

`cwd` starts a sub-agent in a directory with its own config, so role-specific setups (CLAUDE.md, skills, extensions) apply:

```
project/
└── agents/
    ├── game-designer/   ← CLAUDE.md, .pi/…
    └── sre/             ← CLAUDE.md, .pi/…
```

```typescript
subagent({ agent: "worker", cwd: "agents/sre", task: "Review the deployment pipeline" });
```

Set a per-agent default with `cwd:` in frontmatter.

## Status widget & configuration

The widget tracks each sub-agent from a runtime activity snapshot written by the child: `starting`, `active` (turn/provider/tool work), `waiting` (open for input or another stage), `stalled` (no valid snapshot for too long), or `running` (fallback). Sub-agent sessions also show their own tools widget — toggle it with `Ctrl+Alt+O`. Completion messages expand with `Ctrl+O`.

Status display is configured via `config.json` in the extension directory (copy `config.json.example`; it's gitignored):

```json
{
  "status": { "enabled": true }
}
```

## Sub-agent names

A sub-agent's name is canonicalized once at spawn to herdr's agent-label
pattern, `[a-z][a-z0-9_-]{0,31}` — `"Scout Agent 1"` becomes `scout-agent-1`.
That single string is then the widget row, the pane label, the herdr agent
label, and the launch-script and task-artifact filenames, so nothing downstream
needs its own sanitizer. Names omitted by the caller default to the agent name
(already in that shape) and are disambiguated as `scout-2`, `scout-3`, …, never
exceeding the 32-character limit. `subagent_message` accepts either the
canonical name or the free-form one the caller originally passed.

## herdr agent state

Sub-agent panes report their lifecycle to herdr — `working`, `idle`, `unknown` —
so herdr's sidebar, notifications, `agent list` and `agent wait` agree with the
status widget. The parent reports on each sub-agent's behalf, on state
transitions only.

It deliberately does **not** load herdr's own pi integration
(`~/.pi/agent/extensions/herdr-agent-state.ts`) into sub-agents. Sub-agents run
`--no-extensions` by design, and that integration also reports a *session
reference*, which herdr uses to relaunch a pane as plain `pi --session <path>`
after a server restart (`src/agent_resume.rs`) — unsandboxed, with every global
extension and the full toolset. That is the same escalation `subagent_message`
refuses, and `session.resume_agents_on_restore` is global-only, so opting out
would disable restore for your own panes too. Reporting state without a session
reference gives herdr the state it needs and nothing to resume.

`cli: claude` sub-agents are left alone here: herdr's Claude Code integration is
a global hook, so those panes already report for themselves.

## Requirements

- [pi](https://github.com/badlogic/pi-mono)
- [herdr](https://herdr.dev)

```bash
herdr        # then run `pi` in a pane
```

## Acknowledgements

Lineage:

1. [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents)
   originated the sub-agent architecture, the multi-multiplexer surface layer,
   and the status widget. Its supervision features were inspired by
   [RepoPrompt](https://repoprompt.com/).
2. [amosblomqvist/pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents)
   re-implemented it as a tmux-only extension, and is the direct upstream of
   this fork — the async spawn/steer model, the whitelist-only tool sandbox,
   session modes and the status widget are all its work.
3. This fork replaces the tmux surface layer with [herdr](https://herdr.dev).

Tracking upstream:

```bash
git fetch upstream
git rebase -X find-renames=25% upstream/main
```

The rename threshold is needed because `tmux.ts` was `git mv`d to `herdr.ts` and
then rewritten past git's default 50% similarity; without it, an upstream edit
to `tmux.ts` conflicts as *deleted by us* on every rebase instead of merging
into `herdr.ts`.

## License

MIT
