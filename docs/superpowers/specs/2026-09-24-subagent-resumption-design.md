# Persistent subagent conversations

Date: 2026-09-24  
Status: Proposed — awaiting written-spec approval  
Repository: `/srv/code/pi-subagent`  
Baseline: jj change `pxyxtyymrknx`

## 1. Purpose and scope

The controller must be able to send a follow-up task to the **same subagent
conversation**, rather than start another agent with the same name. The main
use case is returning fixes to a reviewer that retains its previous review.
Conversations must survive the end of a child process and a controller restart.

Each new conversation receives an ID such as `reviewer-a1b2c3d4`. The controller
receives that ID in tool output and supplies it through an explicit `resume`
field. Pi's native session history supplies the prior context.

The following decisions were agreed in conversation:

- Separate `agent` (new conversation) from `resume` (existing conversation).
- Store native Pi history and a launch-configuration snapshot together under
  `~/.pi/agent/subagent-sessions/<id>/`.
- Preserve model, thinking level, agent prompt text, tool selection, working
  directory, and agent identity/source on resume.
- Support single, parallel, and chain calls. Show IDs to the model and user.
- Reject unknown IDs and concurrent use of one conversation.
- Keep conversations across controller restarts; do not delete them automatically.
- Develop in this dedicated repository; leave the installed extension unchanged
  until installation is separately approved.

The operational details below make those decisions testable. Approval of this
spec is not approval to execute an implementation plan.

## 2. Starting point and chosen approach

`index.ts` and `agents.ts` were imported unchanged. Both are byte-for-byte
identical to the example shipped with `@earendil-works/pi-coding-agent` 0.87.1.
This comparison was against the installed package, not remote upstream HEAD.
The example's README, sample agents, and prompt templates were not imported.

The current extension discovers agent definitions on every invocation, starts
one `pi --mode json -p --no-session` subprocess per task, collects JSON events,
and renders the current invocation. Parallel calls allow eight tasks with four
running at once. Chains pass the preceding task's final text through
`{previous}`.

**Chosen approach:** retain isolated, one-shot Pi subprocesses, but give each
conversation an explicit native session file and immutable launch snapshot.
Only one subprocess may use a conversation at a time.

Alternatives not selected:

- Reconstruct history from controller tool results: these omit context and can
  truncate output; they are not a substitute for Pi session history.
- Keep a live process per conversation: this adds process supervision and
  controller-lifetime coupling without being necessary for persistence.

Pi remains responsible for messages, tool history, compaction, and context
reconstruction. The extension does not implement a second transcript format.

## 3. Public tool contract

New conversation:

```json
{"agent":"reviewer","task":"Review the implementation"}
```

Follow-up in the same conversation:

```json
{"resume":"reviewer-a1b2c3d4","task":"Review the fixes to your findings"}
```

Parallel and chain items accept the same selector:

```json
{"tasks":[
  {"resume":"reviewer-a1b2c3d4","task":"Recheck the fixes"},
  {"agent":"worker","task":"Inspect the test fixtures"}
]}
```

### Validation

- Exactly one execution mode: a single task, `tasks`, or `chain`. Present batch
  arrays must be nonempty; reject unused mode fields rather than ignoring them.
- Each task has a nonblank `task` and exactly one nonblank selector: `agent` or
  `resume`. Do not interpret an ID in `agent` as a resume request.
- `cwd` is permitted only for a new conversation. Reject it on a resume item;
  the stored directory is authoritative. Top-level `cwd` applies only to single
  mode, as documented by the existing schema; reject it on batch calls.
- Reject malformed selectors, conflicting mode fields, and duplicate resume IDs
  in one parallel batch before starting any tasks. A chain may resume the same
  ID in successive steps because those steps run sequentially.
- `agentScope` and `confirmProjectAgents` remain call-level controls. Scope selects
  definitions for **new** conversations only; it cannot replace a resumed agent.
- Do not add per-call model, prompt, or tool overrides as part of this feature.

Mixed new/resumed batches are supported. A chain stops on its first failed
step, as today. `{previous}` contains only the preceding step's final assistant
text, not an ID banner or status summary. An ID returned by a newly created step
can be used in a later tool call; dynamic references to newly generated IDs
inside the same chain are out of scope.

### Results and rendering

Every started task reports its conversation ID in model-visible text and in
structured result details. The UI shows the ID in collapsed and expanded
results and distinguishes a new call from a resume. Chain summaries include
IDs for **all executed steps**, including steps before a failure. Parallel
summaries associate each output with its own ID even when agent names repeat.

Report the ID as soon as allocation is known through available progress
updates, and repeat it in the final result or failure diagnostic. Never claim
that an allocated ID is resumable if initialization did not complete.

Display and usage counters cover the **current invocation**, not replayed
historical messages. Historical context stays in the child session; do not
return the entire transcript to the controller. Existing output caps remain,
but must not truncate the ID/status header. Continue to preserve full current
results in tool details.

## 4. Storage and identity

Use `path.join(getAgentDir(), "subagent-sessions")`, not a literal home-directory
path. This respects Pi's agent-directory override.

```text
<agent-dir>/subagent-sessions/
  reviewer-a1b2c3d4/
    config.json
    session.jsonl
    .lock/          # present only while owned, or after an interrupted owner
```

The public ID is an extension handle, not Pi's native session UUID. Keep both
identities distinct. Resolve an ID only to its exact directory under this root;
never use fuzzy lookup, arbitrary paths, `--continue`, or Pi's session picker.

Generate the suffix from four cryptographically random bytes, represented by
eight lowercase hexadecimal characters. Make the prefix a filesystem-safe slug
of the agent name: lowercase ASCII letters/digits, replace other runs with `-`,
cap at 64 characters, trim leading/trailing separators, and use `agent` if empty.
An accepted ID has a 1–64 character prefix of lowercase ASCII letters, digits,
and hyphens, starting and ending with a letter/digit, followed by `-` and exactly
eight lowercase hex characters. Store the original name separately. Reserve the
directory with exclusive creation; retry a collision with a new suffix, never
reuse an existing directory. Fail allocation after 16 collisions.

Reject path separators, traversal, malformed IDs, and symlinked conversation
components/files. Derive paths from the validated ID rather than loading paths
from the snapshot. This is defensive file handling, not a sandbox against
malicious programs running as the same OS user.

Create private directories (0700) and files (0600) on POSIX. Publish configuration
atomically. Do not keep credentials, API keys, or the parent's environment in the
snapshot. Sessions can still contain sensitive data from prompts and tool output.

### Launch snapshot

`config.json` has a versioned schema and records:

- Schema version (`1`) and public conversation ID.
- Native Pi session ID, for checking that the transcript belongs to the snapshot.
- Original agent name, source (`user` or `project`), and definition path.
- Canonical discovery working directory and project-agents directory (null for
  a user agent), to identify the original source independently from child cwd.
- Absolute, canonical child working directory.
- Agent system-prompt **text**, not a dependency on the original Markdown file.
- Exact resolved provider and model ID, without a fuzzy alias or thinking suffix.
- Effective thinking level after model capability clamping.
- Effective startup tool names, including extension tools and an empty selection.

Capture resolved child settings, not just requested CLI arguments. In particular,
`tools` omitted in an agent definition must become the child's actual initial
selection, not a marker meaning “whatever defaults exist next time.” An agent's
model alias must become the exact selected model. The parent's active tools are
not necessarily the child's default tools.

The snapshot is immutable once published. It is authoritative for later launch
settings, even if the definition is changed or deleted. Pi's transcript remains
authoritative for conversation history. Unsupported snapshot versions, missing
fields, or mismatched session identity produce an error, not migration by guess.

This freezes the launch configuration, **not the environment**. Repository
files, context files such as `AGENTS.md`, Pi's base prompt, skills, extension
implementations, provider endpoints/credentials, and available models may change.
It is not a claim of exact prompt-cache reuse or byte-for-byte model requests.

## 5. Components and execution flow

Keep responsibilities separate:

- `agents.ts`: discovery and new-conversation agent configuration.
- `index.ts`: tool validation, scheduling, result assembly, and rendering.
- Session storage module: IDs, snapshot validation, safe paths, and leases.
- Child launch module: process lifecycle, arguments, cancellation, and JSON events.
- Small explicitly loaded child bootstrap extension: capture/check effective
  startup configuration before the task can reach a model.

The bootstrap runs only when explicitly requested by a subagent launch. It is
not an independently auto-loaded user extension and adds no model-callable tool.
Its private launch descriptor carries only the identity, prompt, and configuration
needed for this launch; it must not inherit a parent's subagent-bootstrap state.

### New conversation

1. Validate the call, discover the agent, resolve the child directory, and apply
   the existing project-agent approval policy.
2. Reserve a new ID/directory and acquire its lease.
3. Prepare a private empty `session.jsonl` for Pi to initialize, plus temporary
   launch inputs. Only the **new** path may create an empty transcript.
4. Launch Pi in JSON/print mode with the explicit session path and session
   directory, rather than `--no-session`. Preserve the existing new-agent model
   and thinking precedence: an explicit agent model wins; otherwise inherit the
   dispatching session's model/thinking when available.
5. The bootstrap records the native session identity and resolved startup
   selections, then atomically publishes the complete snapshot before admitting
   the task. Failure to capture or persist it must prevent model/tool work.
6. Collect events for this invocation, wait for process closure, release the
   lease, and return the result and ID. Remove temporary inputs, not the session.

### Resume

1. Validate the exact ID and acquire its lease before reading mutable session
   contents or launching a child.
2. Require a complete supported snapshot and a valid, nonempty Pi transcript
   with matching native identity and working directory. Reject malformed or
   truncated records rather than silently accepting a partial history.
3. Require the saved working directory to exist. Evaluate project-agent consent
   using stored provenance; do not rediscover or read a replacement definition.
4. Launch the same explicit session file using the saved prompt, exact model,
   thinking level, tool names, and directory. An empty saved tool list must
   remain empty, not activate defaults.
5. Before admitting the task, the bootstrap verifies the effective model,
   thinking level, and tool selection. A missing model/tool or changed capability
   that prevents the saved selection is an error, not silent fallback. Do not
   overwrite the saved snapshot with newly resolved defaults.
6. Pi appends the new task and response to the existing native conversation.
   Report only this invocation's output and usage, retaining the original ID.

Do not rely on a thrown extension callback alone to stop execution: Pi can
report some extension errors and continue. The bootstrap's fail-closed behavior
must be verified against the installed runtime, including a failure before any
provider request. It must not pollute JSON stdout with unframed diagnostics.

Pi's explicit-session handling can initialize an absent or empty file. Therefore
resume validation is mandatory; passing an ID/path to Pi is not itself proof
that a conversation exists. Creating a private empty file for a **new** session
also lets Pi persist its header before a first successful assistant response.

## 6. Leases, cancellation, and failures

Use a filesystem lease for each conversation, held for the full child lifetime.
An in-memory set alone is insufficient because two controller processes can
resume the same ID. Atomic lock-directory creation is sufficient on the local
filesystem; multi-host/network-filesystem coordination is out of scope.

Contention fails promptly with `conversation busy`, rather than queueing or
forking the conversation. Record an owner token, controller PID, acquisition
time, and child PID once spawned, to diagnose a leftover lease. Release only a
lease bearing the current invocation's owner token and only once the child has
closed (or spawning definitively failed).

Do not automatically expire or steal a lease. A controller can crash while its
child is still alive. After such a crash, recovery is manual: confirm the owning
controller and child are no longer running, then remove that conversation's
lock. Document this procedure. Ordinary cancellation must not leave stale leases.

On cancellation, stop queued work, signal active children, and wait for closure.
Escalate from SIGTERM to SIGKILL after the existing five-second grace period if
the child has not exited. A successfully sent signal (`proc.killed`) is not proof
of process exit. Remove abort listeners and escalation timers after settlement.
Retain the session and identify the interrupted conversation in available output.

Failure rules:

| Condition | Required behavior |
| --- | --- |
| Invalid call or duplicate parallel resume IDs | Reject before dispatch; create no sessions. |
| Unknown ID, incomplete snapshot, missing/invalid transcript | Fail without initializing, replacing, or repairing history. |
| Busy conversation | Fail without starting a second writer. |
| Missing directory, unavailable saved model/tool, incompatible thinking level | Fail without substitution. |
| Spawn, provider, or child-process failure | Report the actual diagnostic and allocated ID; retain persisted state. |
| New-run failure before a complete snapshot/transcript exists | Report initialization failure and that the ID is not resumable. |
| One parallel task fails | Report its failure and retain the other tasks' outputs and IDs. |
| Chain step fails | Stop the chain and report IDs for all steps already executed. |

Use Pi's supported tool-failure signaling for whole-call failures. Do not assume
that a returned `isError` property alone marks an extension tool as failed in
0.87.1. A partial parallel failure is a structured batch result with explicit
per-task status; it must not be reported as complete success.

A follow-up after a failed run uses whatever Pi actually persisted. Do not promise
transactional rollback or exactly-once external actions: a tool may have changed
files before interruption. Retrying sends a new user task; it does not silently
re-execute the previous request.

## 7. Consent and compatibility

Keep the existing project-agent confirmation option. For a stored project agent,
show its saved name, source, and working directory when confirmation is required.
Prior use of an ID is not a new blanket grant of project trust. A trusted controller
project must not automatically establish trust for a different saved project.
When the UI is available and trust of the saved project cannot be established,
ask unless `confirmProjectAgents: false` was explicitly supplied. As in the
baseline, noninteractive operation proceeds without this extra agent-definition
dialog; the option is not a security gate when no UI exists. Pi's own project
resource trust rules still apply. Do not introduce automatic `--approve` for
child resources.

Existing new-agent calls, agent discovery precedence, eight-task/four-worker
parallel limits, streaming, and chain substitution remain compatible except for
intentional changes: persistence, ID/status output, and rejection of ambiguous
selectors. Old ephemeral subagent runs cannot be recovered retroactively.
Older controller results without IDs must still render without throwing.

Target and test Pi 0.87.1 first. Pin the tested development dependency version;
do not claim compatibility with untested Pi releases. Session-format evolution
continues to belong to Pi, while the extension validates its own snapshot version.

## 8. Verification and acceptance

Keep the automated suite lean, using grouped cases and temporary session roots.
No tests may use the user's real sessions or credentials.

1. **Contract and output:** cover new/resume selectors in all modes, malformed
   combinations, duplicate parallel IDs, sequential reuse, distinct IDs for the
   same agent, current-invocation usage, failure summaries, and old-result UI
   compatibility. Check that `{previous}` receives no metadata banner.
2. **Persistence and configuration:** start a child, dispose it and the controller,
   then resume from a fresh process. Change/delete the agent definition and change
   parent defaults between calls. Verify the saved prompt, exact model, thinking,
   tool selection (including defaults/empty), and directory still govern launch.
3. **Safe failure and ownership:** exercise ID collisions, path/symlink rejection,
   invalid/version-mismatched snapshots, absent/truncated/mismatched transcripts,
   startup mismatch, spawn failure, cancellation, and same-ID contention from two
   independent processes. Confirm no second writer or silent new session and no
   provider request after bootstrap failure.
4. **Real Pi integration without paid calls:** use a deterministic test provider
   with the actual CLI/session machinery. The second child must receive the first
   task and response in its model context, append to the same file/native ID, and
   return only its new answer. Include a native compaction fixture so resumption
   does not depend on a hand-built history replay.
5. **Controller-run smoke check:** after installation approval, start and resume
   a reviewer through the real tool. Retain the returned ID and verify a follow-up
   uses the same transcript. Automated evidence alone does not mean the currently
   loaded controller has acquired the new tool schema.

Source completion requires automated groups 1–4 to pass and independent review
to have no open findings. Deployed verification additionally requires smoke
check 5; do not claim it before installation/reload. Formatting, type checking,
and the exact test command belong in the implementation plan. No source behavior
changes accompany this spec.

## 9. Non-goals and workflow

No session browser/list/delete tool, automatic retention, branching, conversation
forking, steering a running child, background jobs/notifications, model switching,
or new model-selection API. Do not change global agent workflow policy as part
of this feature.

The user authorized a **one-change bootstrap exception**: until resume is
available, fresh reviewer conversations may receive prior findings and diffs.
Implementation still goes to a subagent, and every fix still receives independent
re-review. This exception does not establish general Pi workflow support. Plan
review still requires the user's go-ahead; feature execution follows written
spec and implementation-plan approval. The controller owns this spec and other
documentation. Use jj revisions and refer to their change-ids.

Installation/reload is separate from developing the source. Leave
`~/.pi/agent/extensions/subagent/` unchanged until approved; avoid loading both
copies and registering two tools with the same name.

## 10. Sources checked

The installed package root is
`/usr/local/share/npm-global/lib/node_modules/@earendil-works/pi-coding-agent/`.
Paths below are relative to it:

- `docs/cli.md`, `docs/sessions.md`, `docs/session-format.md`: explicit paths,
  storage overrides, native IDs, and context reconstruction.
- `docs/extensions.md`, `docs/sdk.md`, `docs/tui.md`: extension lifecycle,
  configuration access, tool results, and rendering contracts.
- `docs/json.md`: JSON framing and current-invocation event shapes.
- `docs/models.md`, `docs/configuration.md`, `docs/security.md`,
  `docs/environment-variables.md`: resolved model selection, agent root, and trust.
- `examples/extensions/subagent/{README.md,index.ts,agents.ts}`: baseline behavior.
- `examples/sdk/11-sessions.ts`: native session creation/opening.
- `dist/main.js` (`createSessionManager`, `buildSessionOptions`),
  `dist/core/session-manager.js` (`_setSessionFile`, `_persist`),
  `dist/modes/print-mode.js`, and `dist/core/extensions/types.d.ts`: runtime checks
  for explicit-path initialization, persistence timing, startup configuration,
  error handling, and available extension APIs.
