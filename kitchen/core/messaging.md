# Messaging sessions

The `dkitchen_*` tools show what sessions are doing, send them messages, and start new ones. Every one of them is a Deep​Seek​ Harness session: the same conversation is visible in the harness window, and its history is persisted by the harness. The tools are registered in the harness process by the `dsh-dkitchen` bundle, so there is nothing to install beside it and nothing to keep running.

```text
dkitchen_new_session(name="Ablation", station="executor", issue=42, cwd="/path/worktree", message="…")
dkitchen_board()
dkitchen_read(target="#42", head=true)
dkitchen_session_status(target="#42")
dkitchen_info(target="#42")
dkitchen_send(target="#42", sender="Orchestrator", message="…")
```

- **Targets**: a session id, a session name, or a ticket: `OWNER/REPO#42` or the ticket's URL (independent of the current directory), or `#42` (this directory's repo). A ticket resolves to dkitchen's own record of the session that owns it, else to its latest `DSH owner:` line. With no owner line and comments from more than one session, the tools refuse and list the candidates.
- **`dkitchen_new_session`**: creates a session in `cwd`, names it, sends the first message, and returns the session id. By default it waits for that first turn to finish; pass `wait=false` to return as soon as the message is queued. `station` picks which station's model route it runs (`orchestrator`, `designer`, `verifier`, or `executor`) and is required: a station the repo does not run is refused. `provider`/`model` override that route once. For a ticket's executor, add `issue`: the repo's `.dkitchen.toml` adds the ticket prefix to the name (by default `【#42】Ablation`), and the first message asks the session to post its owner line. Until it does, address it by id.
- **`dkitchen_board`**: the sessions this harness process holds, with name, station, ticket, working directory, and — with `status=true` — the first 200 characters of the latest reply. It reads dkitchen's own registry, so a session some other process holds is not listed; that is what the harness window is for.
- **`dkitchen_read`**: the latest assistant reply, read from the harness's session object, so it works while the session is open in the window; `head=true` keeps only its first paragraph. **`dkitchen_session_status`**: the session's turn state as JSON. **`dkitchen_info`**: the session's id, name, working directory, station, ticket, and model route as JSON.
- **`dkitchen_send`**: with `wait=true`, returns once the receiver's turn has settled; without it, as soon as the message is queued, and the message runs after the current turn. Queued is not finished: the result is the receiver's reply on the ticket. If a delivery fails, do not resend blindly — a retry can make the receiver do the work twice. `sender` prefixes the message with `[from NAME]`.
- **A session belongs to one process at a time.** These tools can only message the sessions this harness process opened. A session that the window opened, or another harness process owns, is reported as not open here rather than silently failing; message it from the window, or open the station with `dkitchen_new_session`.
