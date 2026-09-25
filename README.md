# Persistent Pi subagents

A Pi `subagent` extension that starts isolated child processes and resumes their native conversations by public ID. History survives child exit and controller restart. Based on Pi's subagent example; tested with **Pi 0.87.1**, Node.js 22.19+ and a local Linux/POSIX filesystem. Other Pi versions and network filesystems are not verified.

## Develop and verify

From this repository:

```sh
npm ci --ignore-scripts
npm run setup:jj
jj fix -s @
npm run check
```

The gate runs Prettier, strict TypeScript checking and Node tests. Integration tests use the real pinned Pi CLI with an isolated, deterministic local provider: no paid requests or real user credentials. Formatter setup changes only repository-local jj configuration. Use `jj fix -s @` to avoid formatting older revisions.

## Tool calls

These JSON objects are arguments to the `subagent` tool, not shell commands.

Start a new conversation using an existing agent definition:

```json
{ "agent": "reviewer", "task": "Review the implementation" }
```

Copy the returned public ID into a later call:

```json
{ "resume": "reviewer-a1b2c3d4", "task": "Review the fixes to your findings" }
```

The example ID is a placeholder. Supplying `agent` again always starts a new conversation, even for the same name. `resume` never creates a missing conversation.

Mixed parallel calls (at most eight tasks, four active children):

```json
{
  "tasks": [
    { "resume": "reviewer-a1b2c3d4", "task": "Recheck the fixes" },
    { "agent": "worker", "task": "Inspect the fixtures" }
  ]
}
```

Sequential calls can reuse an existing ID:

```json
{
  "chain": [
    { "resume": "reviewer-a1b2c3d4", "task": "List remaining findings" },
    { "resume": "reviewer-a1b2c3d4", "task": "Prioritize these findings: {previous}" }
  ]
}
```

`{previous}` inserts only the preceding step's final assistant text, without ID/status headers. Chains stop at the first failure. Newly generated IDs cannot be referenced dynamically within the same chain; use a later tool call.

Each task needs exactly one of `agent` or `resume` and a nonblank `task`. Do not combine single, parallel and chain fields. Duplicate resume IDs in a parallel call, malformed IDs, and `cwd` on resume are rejected before work starts. `cwd` is allowed for a new task; in a batch, put it on that task, not at the top level.

Results show each executed task's ID and new/resumed status, including failures. Usage, messages and output describe the current invocation only. Parallel text is capped per task without removing ID headers; full current results remain in details. A partial parallel failure preserves other results. Single/chain failures and batches with no successful task are tool errors.

## Agent selection and consent

Definitions are Markdown files with `name` and `description` frontmatter and prompt text in the body. Optional `model` and `tools` select startup settings. User definitions come from `<agent-dir>/agents`; project definitions come from the nearest `.pi/agents` directory above the controller's cwd.

- `agentScope` defaults to `user`; `project` and `both` are also supported. In `both`, project names take precedence. Scope affects **new** conversations only.
- An explicit agent model wins. Otherwise a new child inherits the controller's model/thinking when available. Omitted tools resolve to the child's defaults, not the controller's active tool set.
- Both new and resumed models must exist as exact provider/model entries in the child's loaded Pi catalog. Built-in models and custom models registered through `models.json` or provider extensions qualify. Pi's synthetic fallback for an unlisted ID is rejected. Catalog membership does not establish authentication or provider availability.
- Interactive project-agent use asks for confirmation unless `confirmProjectAgents: false`, or the trusted controller cwd matches both the saved discovery cwd and child cwd. Resume uses saved provenance, even after definition deletion. Dialogs are serialized and cancellable.
- Without a UI, there is no additional agent-definition dialog, as in the original example. Pi's own resource-trust rules still apply; children do not receive automatic `--approve`.

There are no per-call model, prompt or tool overrides for resume.

## Storage and frozen settings

Storage is `path.join(getAgentDir(), "subagent-sessions")`: normally `~/.pi/agent/subagent-sessions`. Pi's `PI_CODING_AGENT_DIR` override changes the agent directory and thus this root; it does not migrate existing conversations. Use an absolute, nonsymlinked path on a local filesystem.

```text
<agent-dir>/subagent-sessions/<public-id>/
  config.json       immutable version-1 launch snapshot
  session.jsonl     native Pi history
  .lock/owner.json  present during use, or after an interrupted owner
```

The public ID is **not** Pi's native session UUID. The snapshot binds the two and saves the original agent name/source/definition path, discovery and child directories, agent prompt text, exact provider/model, effective thinking and effective startup tools. Resume requires the original child directory and uses these settings even if the agent definition is changed, deleted or hidden by scope.

The environment is **not** frozen: repository files, `AGENTS.md`, Pi's base prompt, skills, extension implementations, provider configuration/credentials and model availability can change. Missing models/tools or incompatible saved settings fail rather than silently switch.

New directories/files are created with POSIX modes 0700/0600. Snapshots do not copy credentials or environment variables, but prompts and native history can contain secrets and tool output. Protect backups accordingly. Defensive path checks are not a sandbox against programs running as your OS user.

There is no automatic deletion, retention policy, session browser or migration. Old ephemeral subagent runs cannot be recovered retroactively. Do not edit a snapshot or transcript to bypass validation.

## Failures and recovery

- **Unknown/invalid ID or history:** resume fails without creating or repairing a conversation. This includes invalid compaction references that could otherwise discard retained context. Keep the original files for inspection. Native history validation targets Pi 0.87.1.
- **`not resumable`:** allocation occurred but a valid snapshot/history pair is unavailable. The ID is diagnostic, not a promise of recoverability. Start a new conversation if initialization never completed; do not fabricate its missing files.
- **Busy conversation:** another owner holds `.lock`. No second writer starts, and leases are never stolen based on age. A busy result does not establish whether the history is resumable.
- **Runtime failure/cancellation:** existing history is retained. Cancellation stops queue admission, signals active children, escalates from SIGTERM to SIGKILL after five seconds if needed, and waits for closure before releasing their leases. A later resume adds a new task to whatever Pi persisted.

A progress-reporting callback failure is a whole-call error, even if a task succeeded. It stops queue admission and cancels admitted children; the call waits for their closure and lease cleanup and retains their IDs/results.

An interrupted tool may already have changed files or external systems. There is no rollback or exactly-once guarantee. Inspect effects before asking the agent to retry.

### Manual stale-lease recovery

1. Stop new calls to that public ID. Inspect its `.lock/owner.json`: owner token, controller PID, child PID and acquisition time. If metadata is absent or incomplete, do not assume no child exists.
2. Confirm that **both** the owning controller and child have stopped. Inspect process identities and start times, not only whether a PID exists; PIDs can be reused. A dead controller can leave a live child. If ownership is uncertain, leave the lock intact.
3. Once all possible writers have stopped, remove **only that conversation's `.lock` directory**. Never clear leases because they are old or remove locks across the whole storage root.
4. Retry `resume` using the original public ID. Keep `config.json` and `session.jsonl` unchanged. If validation still fails, investigate; do not erase history to force a new session under the old ID.

## Installation is a separate operation

Source development and automated tests do not update the extension loaded in your controller. This work has **not** changed `~/.pi/agent/extensions/subagent/`.

After installation is separately approved:

1. Back up the previous installed extension outside auto-discovered extension paths.
2. Replace the existing subagent directory with, or point it to, this **complete source directory** with dependencies available. Do not copy only `index.ts`: it imports sibling modules, and child startup explicitly loads `child-bootstrap.ts`. Do not install the bootstrap as a separate auto-loaded extension.
3. Ensure only one copy registers the `subagent` tool; remove duplicate explicit extension paths or package registrations as needed.
4. Reload/restart Pi. Inspect the exposed tool schema and confirm that single and batch task items include `resume`.
5. Start a reviewer and send a follow-up with its returned ID. Verify the same public/native IDs and retained context. This live smoke check is separate from the no-network automated tests and may incur provider costs.

Until installation/reload and this smoke check pass, do not assume the current controller supports resumption or that general reviewer-continuity workflows are available.
