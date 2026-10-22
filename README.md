# dsh-dkitchen

A DeepSeek Harness plugin that turns a repository into a kitchen: stations, tickets, long
jobs, and the bell that wakes a session when its job finishes.

Installing the bundle is the whole installation. The tools are registered inside the harness
process through `ctx.tools`, so there is no Python package to install, no separate profile to
boot, no broker to start, and no MCP server to spawn. Nothing else needs running.

## What it gives a session

| Group | Tools |
| --- | --- |
| Sessions | `dkitchen_new_session`, `dkitchen_send`, `dkitchen_read`, `dkitchen_info`, `dkitchen_rename`, `dkitchen_list_sessions`, `dkitchen_board`, `dkitchen_session_status` |
| Long jobs | `dkitchen_launch`, `dkitchen_logs`, `dkitchen_stop`, `dkitchen_run_status` |
| Tickets | `dkitchen_relay`, `dkitchen_merge`, `dkitchen_log`, `dkitchen_executor_status` |
| Watching | `dkitchen_watch`, `dkitchen_watch_state` |
| Configuration | `dkitchen_config`, `dkitchen_check_refs`, `dkitchen_status` |

The ticket tools need the `gh` CLI. Without it they say so and the rest keep working.

## How a repository configures its kitchen

Each call resolves `.dkitchen.toml` from the repository the session works in, never from the
directory the harness happened to start in — one harness process serves many repositories.

```toml
repo = "owner/name"

[kitchen]
stations = ["orchestrator", "designer", "verifier", "executor"]

[harness]
default_provider = "trae"
default_model = "deepseek-v4.1-flash"

[models.executor]
model = "deepseek-v4.1-flash"

[approval]
allow = ["dkitchen_*"]
```

`dkitchen_status` reports what one repository resolved, and `rootSource` says how that
repository was chosen: `argument`, `session`, or `process`. A `process` answer means the
repository was guessed rather than known.

## Two deliberate behaviours

**`[approval]` answers by rule, and defers by default.** The harness already asks the user
through its own panel, so a plugin that answered ahead of it would remove that decision.
Naming a tool under `allow` answers it without asking, which is what makes an unattended
kitchen able to run what it was configured for; anything else calls `next()`. With no
`[approval]` section the plugin changes no permission behaviour at all.

**A background job's settlement arrives as a session notice.** `ctx.jobs` announces it, so a
session that launched work does not have to poll — the same bell the CLI had to build with
tmux and detached processes.

## The page this bundle adds

`client.js` adds a section to this bundle's page in **Plugins**. It reports whether the bundle
is installed and enabled, and says where a repository's configuration lives. It has no
buttons, because nothing here needs running.

## What this replaces

The Python `ding` runtime drove sessions over ACP through a broker, and shipped its tools
through an MCP server. All three existed because the tools lived outside the harness. They now
live inside it. `docs/ding.md` documents both, and says which parts of the CLI remain.
