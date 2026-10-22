# 🛎️ The dkitchen plugin

[Back to the README](../README.md) · [简体中文](../README.zh-CN.md)

dkitchen ships as a Deep​Seek​ Harness plugin. Installing the bundle is the whole installation:
the tools are registered inside the harness process through `ctx.tools`, so there is no package
to install, no broker to start, no MCP server to spawn, and no second profile to boot.

- [Installing](#installing)
- [What a session gets](#what-a-session-gets)
- [The session tools](#the-session-tools)
- [Long jobs](#long-jobs)
- [The kitchen's routines](#the-kitchens-routines)
- [Configuring a repository](#configuring-a-repository)
- [.dkitchen.toml](#dkitchentoml)
- [The `[approval]` rule](#the-approval-rule)
- [Files dkitchen keeps](#files-dkitchen-keeps)
- [The Plugins page](#the-plugins-page)
- [Troubleshooting](#troubleshooting)

## Installing

Two ways, and both end in the same place.

**From the Discover tab.** In the harness, open **Plugins → Discover**, add the index

```text
https://raw.githubusercontent.com/songmingjun3/dsh-kitchen-plugin/main/docs/market/index.json
```

and install `dkitchen`. The index names a pinned commit of this repository, so the harness
clones exactly the version it lists.

**From a release or a checkout.** Download the archive attached to a
[release](https://github.com/songmingjun3/dsh-kitchen-plugin/releases), or clone this
repository, then open **Plugins → install bundle** and point it at the directory holding
`package.json`. This repository *is* the bundle, so that is its root.

Either way, the harness composes the bundle's `cordis.patch.yml` into the profile and loads
`index.js`. Restart the harness if it does not pick the bundle up by itself. On first start the
bundle also installs the setup skill into the machine-wide skill root, so `/setup-dkitchen`
works in every project.

A bundle that fails to register a tool does so silently — the process keeps running and the
tool simply is not there. Set `debug: true` in `cordis.patch.yml` to have each registration
reported on stderr, which is the quickest way to see why a tool is missing.

## What a session gets

| Group | Tools |
| --- | --- |
| Sessions | `dkitchen_new_session`, `dkitchen_send`, `dkitchen_read`, `dkitchen_info`, `dkitchen_rename`, `dkitchen_list_sessions`, `dkitchen_board`, `dkitchen_session_status` |
| Long jobs | `dkitchen_launch`, `dkitchen_logs`, `dkitchen_stop`, `dkitchen_run_status` |
| Tickets | `dkitchen_relay`, `dkitchen_merge`, `dkitchen_log`, `dkitchen_executor_status` |
| Watching | `dkitchen_watch`, `dkitchen_watch_state` |
| Configuration | `dkitchen_config`, `dkitchen_check_refs`, `dkitchen_status` |

The ticket and watch tools need the `gh` CLI. Without it they say so and the rest keep working.

## The session tools

Every session a station runs is a real harness session: the harness creates it, persists it,
and shows it in its window.

```text
dkitchen_new_session(name="Ablation", station="executor", issue=42, message="Review the evaluation config.")
dkitchen_board()
dkitchen_read(target="#42", head=true)
dkitchen_send(target="#42", sender="orchestrator", message="GPU 5 is free now; go ahead with stage 2.")
```

- **`dkitchen_new_session`** requires `name`, `message`, and `station`. It creates the session
  in `cwd` (default: the calling session's directory), pins its harness title to the name, and
  records it in dkitchen's registry. With `issue`, the repository's name template adds the
  ticket prefix and the first message asks the session to post its owner line. It waits for
  the first turn unless `wait=false`.
- **Targets** are a session id, an exact name, `#42`, `OWNER/REPO#42`, or an issue URL. A
  ticket resolves to dkitchen's registry first, then to the latest `DSH owner:` line on the
  ticket.
- **`dkitchen_board`** lists what this harness process holds. A session another process opened
  is not in that list — the harness window is where you see those.
- **`dkitchen_send`** can only message a session this process opened. With `wait=true` it
  returns once the turn has settled; without it, as soon as the message is queued.

## Long jobs

```text
dkitchen_launch(name="train", command=["python", "train.py"], cwd="/abs/worktree")
dkitchen_logs(job="train-<id>")
dkitchen_stop(job="train-<id>")
dkitchen_run_status()
```

`dkitchen_launch` hands the command to the harness's own job registry and returns at once with
a job id. When the job exits, the harness delivers the settlement as a session notice, so the
session that started it does not have to poll. A job belongs to the session that started it:
another session cannot read or stop it.

`dkitchen_logs` returns the trailing lines of the buffered output, 40 by default or `lines=N`.
`dkitchen_run_status` reads `runs.jsonl` and lists the jobs this session started, which is how
a job whose notice was missed is still accounted for.

There is no pane to attach to: the harness buffers the output, on both Linux and Windows.

## The kitchen's routines

- **`dkitchen_relay`** sends a message to a ticket's executor and leaves the comment only once
  delivery is confirmed. A relay that fails leaves no comment that would claim work which never
  started.
- **`dkitchen_merge`** takes the PR number, the reviewed HEAD, and the ticket. It merges only
  at that HEAD, and only while the executor's latest status block on the ticket is waiting on
  the orchestrator. A PR with no ticket passes `no_ticket`.
- **`dkitchen_log`** posts a signed, UTC-stamped entry to the orchestrator log ticket:
  `items` for automatic actions, `pending` for matters waiting on the user.
- **`dkitchen_check_refs`** checks every `file:line` and `sha256` a draft cites, and reports
  separately what is wrong and what could not be checked.
- **`dkitchen_watch`** returns one batch of GitHub activity and ends. Calling it again is the
  loop; it is not a background daemon. `dkitchen_watch_state` shows the state file it keeps,
  and `reset=true` forgets it.

## Configuring a repository

Each call resolves `.dkitchen.toml` from the repository the session works in, never from the
directory the harness happened to start in — one harness process serves many repositories.

```text
dkitchen_status()
dkitchen_config(action="show")
dkitchen_config(action="models")
dkitchen_config(action="set", key="models.verifier.model", value="claude-sonnet-5")
dkitchen_config(action="set", key="kitchen.stations", value="orchestrator,executor")
```

`dkitchen_status` reports what one repository resolved and says how the repository was chosen:
`rootSource` is `argument`, `session`, or `process`. A `process` answer means the repository was
guessed from the harness's own directory rather than known.

`dkitchen_config` with `action="set"` edits the file surgically, keeping every other line and
its comments, and reads the result back so a value the reader refuses is reported immediately.

## .dkitchen.toml

Put this file at the repo root to change the kitchen's words, its stations, and their routes.
Every key is optional; these are the defaults:

```toml
repo = "owner/name"                  # default: the repository gh sees here

[kitchen]
stations = ["orchestrator", "designer", "verifier", "executor"]

[harness]
default_provider = "deepseek-official"
default_model = "deepseek-v4-flash"

[models.executor]                    # one table per station; every key optional
provider = "docode-claude"
model = "claude-sonnet-5"
effort = "high"                      # reasoning effort, when the model declares one

[stations]
orchestrator = "Orchestrator"
designer = "Designer"
verifier = "Verifier"
executor = "Executor"
user = "User"
separator = ": "                     # written after a station name to sign a comment

[status]
fields = ["Status", "Waiting on", "Key numbers", "Next"]   # first: the state; second: who it waits on
in_progress = "in progress"
waiting_on_design = "waiting on design"
blocked = "blocked"
done = "done"
none = "none"                        # a "Waiting on" value that names nobody

[labels]
prefix = "status:"
awaiting_user = "status:awaiting-user"

[log]
issue = 1                            # the pinned orchestrator log ticket
pending = "Waiting for the user"

[sessions]
owner_line = "DSH owner"             # the line that claims a ticket
session_line = "DSH session"         # the line that signs a comment
name = "【#{issue}】{name}"            # session name for a session opened with an issue
```

`[sessions] name` may use `{issue}`, `{name}`, and `{repo}`. Any other field is an error when
the file is read.

`owner_line` and `session_line` change what new comments say; the old `Codex` spellings are
always read too, so a repository can migrate one ticket at a time.

A misspelled key is an error naming the file and the key. That is deliberate: silently falling
back to a default is how a kitchen ends up running a station nobody configured.

## The `[approval]` rule

```toml
[approval]
allow = ["dkitchen_*"]
reject = ["bash"]
```

The harness already asks the user through its own panel, so a plugin that answered ahead of it
would remove that decision. Naming a tool under `allow` answers it without asking, which is what
lets an unattended kitchen run what it was configured for; anything else calls `next()`. With no
`[approval]` section the plugin changes no permission behaviour at all.

## Files dkitchen keeps

Everything lives under one state directory, readable only by you: `$DKITCHEN_STATE_HOME` if
set, else `$XDG_STATE_HOME/ding`, else `%LOCALAPPDATA%\dkitchen` on Windows, else
`~/.local/state/ding`.

| Path | Contents |
| --- | --- |
| `sessions.json` | dkitchen's record of the sessions it created: name, station, ticket, route |
| `runs.jsonl` | One line per job lifecycle event: `run_start` and `run_stop` |
| `watch/OWNER-REPO.json` | Where `dkitchen_watch` left off |

A `runs.jsonl` line looks like this:

```json
{"event":"run_start","run_id":"train-1a2b…","name":"train","cwd":"/abs/worktree","command":["python","train.py"],"pid":1234,"started_ns":1791799200000000000}
```

The harness's own session logs live where Deep​Seek​ Harness puts them, `$DSH_HOME/sessions/`.
dkitchen does not write there.

The setup skill is installed once per machine, into `<DSH_HOME>/skills/setup-dkitchen/`, with
its templates beside it in `<DSH_HOME>/skills/kitchen/`. A marker file records which bundle
version wrote it, so an upgrade replaces the copy and an unchanged version costs one directory
read at startup.

## The Plugins page

The bundle adds a section to its own page in **Plugins**. It reports whether the bundle is
installed and enabled and where a repository's configuration lives. It has no buttons, because
nothing here needs running.

## Troubleshooting

| Symptom | What it means and what to do |
| --- | --- |
| No `dkitchen_*` tool appears | The bundle did not load, or a registration was refused. Enable `debug: true` in `cordis.patch.yml`, restart, and read stderr. |
| A tool reports `rootSource: process` | The repository was guessed from the harness's own directory. Open the session in the repository, or pass `cwd`. |
| `dkitchen_send` says the session is not open here | That session belongs to another process, typically the window. Message it from there. |
| Ticket tools say `gh` is missing | Install the `gh` CLI and log in; the other tools do not need it. |
| `.dkitchen.toml` is refused | The error names the key. `tests/config.test.mjs` holds every refusal the reader can produce. |
| The setup skill is stale | The copy is versioned by the bundle. Upgrade the bundle, or delete `<DSH_HOME>/skills/setup-dkitchen/` and restart. |
