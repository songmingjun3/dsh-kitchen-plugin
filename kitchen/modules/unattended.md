# While the user is away

When the user is away, an issue watcher wakes the orchestrator, which moves forward only what existing approvals already cover. The test for every step: **if anyone would do it the same way, do it. If there are several reasonable ways and the choice affects results, cost, or direction, stop and wait for the user.** Approvals come only from the user's own words; the watcher, the orchestrator, and the designer never produce one.

## The watch

The orchestrator calls the watch at the end of every round, and calls it again after handling each batch.

```text
dkitchen_watch()
```

The tool returns one batch and ends; it does not sit in the background waiting. That is the shape a tool has to have — a call that never returned would hold its turn open forever — so the orchestrator calling it in a loop *is* the watch.

It only reads GitHub and the run records; it calls no model. One call reports everything that appeared since the previous one, gathered into a single batch so related changes arrive together:

- an executor comment whose Status is not `in progress`, or whose Waiting on names a station or the user;
- a comment from the user;
- a `status:*` label being added;
- a new PR;
- an executor gone quiet: `in progress` for over 6 hours without a comment, with no job running for it. `stale_hours` changes the threshold, and `check_stale=false` leaves quiet executors out.

Verifier comments never wake it on their own, since the verifier also messages the orchestrator; they are listed in the next batch for reference. It skips the orchestrator log ticket set in `.dkitchen.toml`; `skip_issue` adds others. One watch runs at a time: a second call while one is in flight is refused rather than producing a duplicate batch.

The state file — where the next batch starts from, and what has already been reported — is worth inspecting when a batch repeats: `dkitchen_watch_state` shows it, and `reset=true` forgets it.

A closed session or a host reboot stops the round: the watch is a call this session makes, so when the session is gone, nothing is watching. When the user is back, `dkitchen_board` shows which stations are still open.

## What the orchestrator moves forward

- **Next stage**: an executor reports a stage done, and the ticket already approves the next stage with no "wait for the designer" checkpoint: tell it to continue. With a checkpoint, forward the report to the designer.
- **Stuck or quiet executor**: hand it to the verifier to find the cause, then decide by this file and the list below.
- **Results**: forward them to the designer for interpretation.
- **New PR**: review and merge it as in [roles.md](roles.md#reviewing-prs). PRs that change frozen files, `docs/agents/`, rule or process files, or code a running job depends on wait for the user or the designer.
- **Finished tickets**: label and close them. Tickets whose exit conditions include something for the user, or whose results the designer has yet to interpret, stay open.
- **Host reboot**: reopen tunnels and have executors resume with their original commands. Shared services that went down wait for the user to restart them.

## What the designer can decide

Actionable, decided by the designer alone:

- adding detail to metrics and steps the ticket already has, such as how a statistic is counted;
- resolving places where a rule does not fit reality, such as the details of failure handling;
- spending within the ticket's approved budget<!-- module:model-text -->;
- adjusting model-visible text after an exploration step, as [model-text.md](model-text.md) allows<!-- /module:model-text -->.

Exit thresholds and decision rules set in advance stay as they are.

Waiting for the user: changing the goal, the dataset, or experimental conditions; changing decision rules and thresholds set in advance; research conclusions and paper claims; going over the approved budget; opening tickets in a new direction. When the verifier and the designer disagree, both views stay on the ticket for the user.

## The log

After each batch, the orchestrator records it on the pinned "Orchestrator log" ticket:

```text
dkitchen_log(
  items=["#42 told the executor to start stage 2; approved in the ticket budget"],
  pending=["#57 needs a dataset choice"],
)
```

The time is filled in, in UTC. Each automatic action gets one `items` entry: the ticket, what was done, and which approval covered it. Each matter waiting for the user gets one `pending` entry; leave the list empty when there are none.
