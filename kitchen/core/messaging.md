# Messaging sessions (ding)

`ding` shows what sessions are doing, sends them messages, and starts new ones. Every one of them is a DeepSeek Harness session: the same conversation is visible in the harness GUI, and its history is persisted by the harness. Install it with `pipx install dkitchen`; the full guide is at https://github.com/songmingjun3/dkitchen/blob/main/docs/ding.md.

```bash
ding new --cwd /path/worktree --issue 42 --name 'Ablation' --station executor --message-file /path/brief.md
ding board
ding read --head '#42'
ding status '#42'
ding info '#42'
ding send '#42' --from Orchestrator --message-file /path/message.md
```

- **Targets**: a session id, a session name, or a ticket: `OWNER/REPO#42` or the ticket's URL (independent of the current directory), or `'#42'` (this directory's repo; quote the `#`). A ticket resolves to dkitchen's own record of the session that owns it, else to its latest `DSH owner:` line. With no owner line and comments from more than one session, `ding` refuses and lists the candidates.
- **`new`**: creates a session in `--cwd`, names it, sends the first message, and prints only the session id. It does not wait for the reply. `--station` picks which station's model route it runs (`orchestrator`, `designer`, `verifier`, or `executor`), and `--provider`/`--model` override that route once. For a ticket's executor, add `--issue N` and keep `--name` to a few words: the repo's `.dkitchen.toml` adds the ticket prefix (by default `【#42】Ablation`), and the first message asks the session to post its owner line. Until it does, address it by id.
- **`board`**: sessions of this repo and its worktrees, with name, status, ticket, and the first paragraph of the latest reply. `--all` lists every session and is slow.
- **`read`**: the latest reply, read from the harness's own session log, so it works even while the GUI has the session open; `--head` prints only its first paragraph. **`status`**: the session's live state as JSON. **`info`**: the session's id, name, working directory, station, and model route as JSON.
- **`send`**: when the receiver is idle, `ding` confirms the message started running; when it is busy, `ding` returns once the message is queued, and the message runs after the current turn. Started is not finished: the result is the receiver's reply on the ticket. On a nonzero exit (`queued`, `unknown`), check the send log before sending again, since a resend can make the receiver do the work twice. `--from` names the sender; long messages go in `--message-file`. Every send is logged in the ding state directory (`sent.jsonl`).
- **A session belongs to one process at a time.** The broker `ding` starts owns its sessions; if you open one in the DeepSeek Harness GUI at the same time, the harness refuses and `ding` reports which session is taken rather than fighting for it. Close it there, or keep using `ding`.
