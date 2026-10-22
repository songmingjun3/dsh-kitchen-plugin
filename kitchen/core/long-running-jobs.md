# Long-running jobs

Start every CPU, GPU, or API job that outlives a turn with `ding launch`, however short you expect it to be. It opens the job under a name of your choosing, wraps it with `ding run`, and wakes the session that launched it when the job exits. The same command works on Linux (tmux) and Windows (a detached process), and `ding logs` / `ding stop` work on both.

```bash
ding launch issue42-stage1 --message "$message" --record /absolute/path/task-exit.jsonl -- env OMP_NUM_THREADS=8 bash /absolute/path/task.sh
ding logs issue42-stage1            # the job's own latest output
ding stop issue42-stage1            # end it and everything it started
```

After launching, end your turn: the job's exit wakes you. Look at progress only when the user asks.

- **Where the output goes**: on Linux the job runs in tmux session `ding-NAME` and the pane stays open after exit; read it with `tmux attach -t ding-NAME` and close it with `tmux kill-session -t =ding-NAME` when done. On Windows the job runs detached and its output goes to a log file that `ding launch` prints and `ding logs NAME` reads.
- **The environment**: a launched job inherits this process's environment plus `DSH_SESSION_ID` and `DKITCHEN_RUN_ID`. On Linux under tmux, only `PATH`, `HOME`, `PYTHONPATH`, and the session id are guaranteed, so pass anything else explicitly as `env K=V` in the command.
- **After exit**: the record says which exit code it was, and the wake-up message is `Task NAME exited; inspect <record>` unless you gave your own.
- **Unwrapped jobs**: on Linux, the end of `ding board` lists tmux jobs on this host that have run for over 10 minutes without `ding`. The orchestrator asks the executor that owns one to relaunch it with `ding launch`. Windows has no such audit; `ding board` lists the jobs `ding` itself started.
- **Missed wake-ups**: the wrapper was killed, the host rebooted, or the job hangs. The wake-up comes once, when the job exits, so follow-up messages are never queued in advance. `ding board` shows `lost` or `notify_failed` when this happened.

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
- **A host reboot** takes the running jobs and tunnels with it, and `ding run` has no chance to write exit records: the job's exit record is empty and its process is gone. Reopen the tunnels first, then have each ticket resume with its original command.
