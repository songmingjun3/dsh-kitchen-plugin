# The kitchen

These are the house rules of dkitchen, as templates. The setup skill installs them into a repo's `docs/agents/` and adapts them to that repo; you can also read them here to see how the kitchen runs.

Every station is a **Deep​Seek​ Harness session**. The kitchen does not run a separate agent stack: the `dsh-dkitchen` bundle registers its tools inside the harness process, and those tools create sessions, deliver messages between them, and read their replies back through the harness's own session objects. So the same conversations are visible in the harness window, and nothing runs beside the harness.

## Layout

| Template | Installed as | What it covers |
| --- | --- | --- |
| [core/agents-block.md](core/agents-block.md) | blocks in `AGENTS.md` (and `CLAUDE.md` when it exists) | The pointers every session reads |
| [core/roles.md](core/roles.md) | `docs/agents/roles.md` | Stations, who decides what, verification, results, relaying, signatures, PR review |
| [core/issue-tracker.md](core/issue-tracker.md) | `docs/agents/issue-tracker.md` | Tickets, executor comments, the status block, status labels |
| [core/messaging.md](core/messaging.md) | `docs/agents/messaging.md` | Messaging sessions with the `dkitchen_*` tools |
| [core/long-running-jobs.md](core/long-running-jobs.md) | `docs/agents/long-running-jobs.md` | `dkitchen_launch`, resumable jobs, compute and shared services |
| [modules/run-budgets.md](modules/run-budgets.md) | `docs/agents/run-budgets.md` | Run requests, ticket budgets, what needs the user's approval |
| [modules/model-text.md](modules/model-text.md) | `docs/agents/model-text.md` | Prompts and other text a model sees, owned by the designer |
| [modules/artifacts.md](modules/artifacts.md) | `docs/agents/artifacts.md` | The artifact registry and frozen files |
| [modules/unattended.md](modules/unattended.md) | `docs/agents/unattended.md` | Running while the user is away: the issue watcher and the orchestrator log |

Core files go into every kitchen. Each module is optional.

## Stations are chosen per repo

The repo's `.dkitchen.toml` lists the stations this kitchen runs:

```toml
[kitchen]
stations = ["orchestrator", "executor"]
```

Every station named there is opened once and keeps its own harness session. A station that is not listed is not opened, and its duties fall to the orchestrator, as [roles.md](core/roles.md) describes for the minimal kitchen. Changing the list later takes effect for the next session: `dkitchen_config` with `action="set"`, `key="kitchen.stations"`, or rerun the setup skill.

Each station also has its own model route, so the orchestrator can run on the strongest model while the verifier runs on a cheaper one:

```toml
[models.orchestrator]
provider = "docode-claude"
model = "claude-opus-5-5"
effort = "high"

[models.verifier]
provider = "docode-claude"
model = "claude-sonnet-5"
effort = "low"
```

`dkitchen_config` with `action="models"` reports which route each station would use and whether it inherited the default; `dkitchen_info` shows the route a session actually runs.

## Template markers

- `<!-- module:NAME -->` … `<!-- /module:NAME -->` wraps text that belongs to module `NAME`. When the module is installed, keep the text and drop the markers. When it is not, drop the text too.
- `<!-- fill: … -->` marks a gap the setup skill fills from the repo and the user's answers, such as hosts, GPUs, or shared services.

## Vocabulary

The rules and the tools share one vocabulary. The defaults are below. A kitchen in another language changes these words in the rules and in the repo's `.dkitchen.toml` together, so that people, agents, and scripts keep agreeing.

| Word | Default | Read by |
| --- | --- | --- |
| Station names | Orchestrator, Designer, Verifier, Executor | Everyone |
| Signatures | A comment's first line starts with `Orchestrator:`, `Designer:`, or `Verifier:` (Markdown heading marks allowed). Executor comments carry a `DSH session:` line. Anything else is the user's. | `dkitchen_watch`, `dkitchen_relay`, `dkitchen_log` |
| Owner line | `DSH owner: <session id>` | `dkitchen_send`, `dkitchen_relay`, `dkitchen_info` |
| Status fields | `Status`, `Waiting on`, `Key numbers`, `Next` | `dkitchen_board` (`status`), `dkitchen_watch` |
| Status values | `in progress`, `waiting on design`, `waiting on user`, `blocked`, `done` | `dkitchen_watch` |
| Nobody to wait on | `none` | `dkitchen_watch` |
| Designer reply type | `Type: actionable`, `Type: proposal, awaiting user` | Orchestrator, executors |
| Status labels | `status:awaiting-design`, `status:awaiting-user`, `status:blocked`, `status:done` | `dkitchen_watch`, `gh issue list` |

Tickets written before the move to Deep​Seek​ Harness say `Codex owner:` and `Codex session:`. Those lines still resolve, so an old ticket needs no rewriting; new comments always use the `DSH` spelling.

## Tools the rules call

Two layers:

- **The `dkitchen_*` tools** come from the `dsh-dkitchen` bundle and work in every repo: `dkitchen_relay`, `dkitchen_merge`, `dkitchen_log`, `dkitchen_watch`, `dkitchen_check_refs`, and the session tools in [messaging.md](core/messaging.md). Sessions themselves belong to Deep​Seek​ Harness; these tools open and message them.
- **Repo scripts** depend on the repo, so the setup skill writes them into the repo's `scripts/`, starting from reference versions: `review_pr.py` for PR review, and the checks some modules use.
