# Blocks for AGENTS.md and CLAUDE.md

Every session loads these lines, so each one is a pointer to a doc under `docs/agents/`, worded by when to reach it. DeepSeek Harness reads `AGENTS.md` (and `CLAUDE.md`) automatically and keeps them current as a session changes directory, so the first block is what every station sees. Add the second block only if the repo also keeps a `CLAUDE.md` for other tooling.

## AGENTS.md

```markdown
- **Roles**: at session start, and before messaging another session or interpreting a result, read [docs/agents/roles.md](docs/agents/roles.md).
- **Long-running jobs**: start every long job with `ding launch`; compute and shared services are in [docs/agents/long-running-jobs.md](docs/agents/long-running-jobs.md).
- **GitHub issues**: append `DSH session: <session id>` to every issue body or comment you post, using `$DSH_SESSION_ID` (PowerShell: `$env:DSH_SESSION_ID`). Open each comment with the status block<!-- module:run-budgets -->, and write run requests<!-- /module:run-budgets -->, as in [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md#executor-comments).
```

## CLAUDE.md

```markdown
@AGENTS.md
```

That is all the kitchen needs: a repo that also keeps a `CLAUDE.md` should point it at `AGENTS.md` rather than repeat the rules, so the two files cannot drift apart.
