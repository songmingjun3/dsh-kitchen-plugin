# Long-running jobs

Start every CPU, GPU, or API job that outlives a turn with the `dkitchen_launch` tool, however short you expect it to be. It registers the job with the harness under a name of your choosing and wakes the session that launched it when the job exits. The same call works on Linux and Windows, and `dkitchen_logs` / `dkitchen_stop` work on both.

```text
dkitchen_launch(name="issue42-stage1", command=["env", "OMP_NUM_THREADS=8", "bash", "/absolute/path/task.sh"])
dkitchen_logs(job="<the id dkitchen_launch returned>")      # the job's own latest output
dkitchen_stop(job="<the same id>")                          # end it and everything it started
```

After launching, end your turn: the job's exit wakes you. Look at progress only when the user asks.

- **How the notice arrives**: the harness announces the settlement as an in-session notice, so you do not poll. Nothing is queued in advance: a wake-up you slept through does not come again, and `dkitchen_logs` is then how you catch up.
- **What a job id is**: `dkitchen_launch` returns one, and it — not the name — is what `dkitchen_logs` and `dkitchen_stop` take. A job belongs to the session that started it, so one session cannot read or stop another's.
- **Where the output goes**: the harness buffers the job's standard output and error, and `dkitchen_logs` returns the trailing lines of it (40 by default, or `lines=N`). Read it from there rather than from a terminal: there is no pane to attach to.
- **The environment**: a launched job is a child of the harness process and inherits its environment. The session id is not added for it, so pass anything it needs explicitly, as `env K=V` at the front of the command.
- **After exit**: `dkitchen_run_status` lists the jobs this session started, from the run record the kitchen keeps, so a job whose notice you missed is still accounted for.
- **A command that cannot start** fails at launch, with the reason, rather than as a job that immediately reports failure.

## Resumable jobs

Every long job is resumable: rerunning the original command continues it. This is what lets the kitchen recover from a crash or reboot without asking anyone.

- A result counts only once it is durably on disk, written atomically. A killed job loses no committed result and counts none twice.
- On resume, the job first checks that its inputs and config still match the existing outputs. On a mismatch or corrupt output, it keeps the originals and stops with a clear error. Otherwise it skips committed results and redoes only unfinished work.
- A clear failure of one sample is final: record it, move on, and keep it in the evaluation's denominator. Service, environment, resource, and unknown failures are retried a bounded number of times, then the job pauses with the work left pending, ready for a rerun.

## Compute

<!-- fill: the hosts and GPUs this repo may use, how to tell a GPU is free on each, and which GPUs belong to other people. -->

Other users' processes are never touched. Processes under our own account are ours, but before stopping one, confirm it is not another ticket's job.

## Shared services

<!-- fill: a table of shared services (model servers, databases, tunnels) with columns Service | Where | Owner, and the command that checks their load, if the repo has one. -->

- **Restarts and parameter changes** of shared services are the user's. Before one, the clients are told to stop at a checkpoint with SIGINT; afterwards they resume with their original commands.
- **Tunnels**: when a tunnel is down, the orchestrator, or the executor that needs it, reopens it. <!-- fill: where tunnels run and the command for each. -->
- **A host reboot** takes the running jobs and tunnels with it, and a job that was running has no chance to report how it ended. Reopen the tunnels first, then have each ticket resume with its original command through `dkitchen_launch`.
