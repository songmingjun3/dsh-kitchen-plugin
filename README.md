# dsh-dkitchen

[![Tests](https://github.com/songmingjun3/dsh-kitchen-plugin/actions/workflows/tests.yml/badge.svg)](https://github.com/songmingjun3/dsh-kitchen-plugin/actions/workflows/tests.yml)
[![Release](https://img.shields.io/github/v/release/songmingjun3/dsh-kitchen-plugin)](https://github.com/songmingjun3/dsh-kitchen-plugin/releases/latest)
[![License](https://img.shields.io/github/license/songmingjun3/dsh-kitchen-plugin)](LICENSE)

**English** | [简体中文](README.zh-CN.md)

A DeepSeek Harness plugin that turns a repository into a kitchen: stations, tickets, long
jobs, and the bell that wakes a session when its job finishes.

Installing the bundle is the whole installation. The tools are registered inside the harness
process through `ctx.tools`, so there is no package to install, no separate profile to boot, no
broker to start, and no MCP server to spawn. Nothing else needs running.

> **Based on [917Dhj/dkitchen](https://github.com/917Dhj/dkitchen).** The kitchen itself — the
> stations, the ticket workflow, the house rules, and the bell that wakes a session — is the
> design of [917Dhj/dkitchen](https://github.com/917Dhj/dkitchen), and this plugin is its port
> to the DeepSeek Harness plugin runtime. See [Acknowledgements](#acknowledgements).

## Install

**From Discover.** In the harness, open **Plugins → Discover**, add this index

```text
https://raw.githubusercontent.com/songmingjun3/dsh-kitchen-plugin/main/docs/market/index.json
```

and install `dkitchen`. The index pins an exact commit of this repository, so what you get is
what a release names.

**From a release.** Download the source archive of a tag from
[Releases](https://github.com/songmingjun3/dsh-kitchen-plugin/releases), then point
**Plugins → install bundle** at the unpacked directory.

Either way the harness composes `cordis.patch.yml` into the profile and loads `index.js`.
Restart the harness if it does not pick the bundle up by itself. On first start the bundle also
installs the setup skill into the machine-wide skill root, so `/setup-dkitchen` works in every
project.

A bundle that fails to register a tool does so silently — the process keeps running and the
tool simply is not there. Set `debug: true` in `cordis.patch.yml` to have each registration
reported on stderr.

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
session that launched work does not have to poll.

## The page this bundle adds

`client.js` adds a section to this bundle's page in **Plugins**. It reports whether the bundle
is installed and enabled, and says where a repository's configuration lives. It has no
buttons, because nothing here needs running.

## Layout

| Path | Role |
| --- | --- |
| `index.js` | Mounting the plugin: injected services, per-call config resolution, tool registration |
| `lib/` | The tools and the rules behind them |
| `kitchen/` | The station rules the setup skill renders into a repository |
| `skills/setup-dkitchen/` | The setup skill, with a renderer that needs only Node |
| `scripts/market.mjs` | Generating and validating `docs/market/index.json` |
| `docs/plugin.md` | The user-facing guide: installing, every tool, every `.dkitchen.toml` key |
| `tests/` | The suite: `node --test "tests/*.test.mjs"` |

This repository is the bundle: `package.json`, `index.js`, and `lib/` are at the root, which is
why the market index names it without a `path`.

## Development

```bash
node --test "tests/*.test.mjs"     # the suite; nothing to install first
node scripts/market.mjs index --check
```

On Windows under a restricted shell, `node --test` cannot spawn its per-file child processes;
run `node --test --experimental-test-isolation=none "tests/*.test.mjs"` there instead.

Releasing: bump `version` in `package.json`, then push a matching tag such as `v1.0.0`. The
release workflow checks the two agree, runs the suite, regenerates the market index for that
tag's commit, and publishes the GitHub release.

## Acknowledgements

This plugin is a port, not an original design. The kitchen it implements — stations with fixed
duties, work handed off through GitHub issues as tickets, the status block every comment opens
with, the rules for when a station must stop and ask, and the bell that wakes a session when its
long job exits — comes from **[917Dhj/dkitchen](https://github.com/917Dhj/dkitchen)**, and this
repository follows its functional design closely on purpose: the vocabulary, the refusals, and
the order in which the orchestrator does things are all meant to match. Thank you to
917Dhj/dkitchen for thinking it through and writing it down.

What differs here is the runtime, not the kitchen. That project drove DeepSeek Harness sessions
from outside the process — a CLI, a broker, an MCP server, a separate profile. This one
registers the same tools inside the harness through `ctx.tools`, so installing the bundle is the
whole installation. The behaviour is meant to stay the same; where this port had to choose, the
choice is recorded in the commit that made it and in the tests.

The metaphor, and much of the workflow, traces further back: the Michelin-kitchen way of running
agents comes from Lauren Tan ([Poteto](https://github.com/poteto)), and the practice of keeping
tickets on GitHub issues started from the issue tracker setup in
[Matt Pocock's skills](https://github.com/mattpocock/skills).

## License

[MIT](LICENSE)
