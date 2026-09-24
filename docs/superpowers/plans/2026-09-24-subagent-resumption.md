# Persistent Subagent Conversations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Implementation remains delegated; the controller owns documentation and final validation.

**Goal:** Let a controller resume a persistent subagent conversation by its returned `<agent-name>-<8-hex>` ID, retaining history and original launch settings across process restarts.

**Architecture:** Keep one isolated Pi CLI subprocess per invocation. Add a filesystem session store with exclusive leases and an explicit child bootstrap extension that records/verifies effective startup settings before admitting the task. Dispatch and rendering operate on per-invocation results, not reconstructed history.

**Tech Stack:** Node.js 22.19+ on the existing Linux/POSIX environment; TypeScript; Pi packages pinned to 0.87.1; TypeBox 1.3.27; Node's test runner with tsx; existing Prettier 3.6.2 and jj.

**Spec:** `docs/superpowers/specs/2026-09-24-subagent-resumption-design.md`.

**Status:** User authorized independent plan review on 2026-09-24 and execution after it passes. Initial review requested changes; no feature task has started.

## Global Constraints

These requirements apply to every task and must travel with each implementer brief:

- Separate `agent` (new conversation) from `resume` (existing conversation).
- Use `path.join(getAgentDir(), "subagent-sessions")`, not a literal home-directory path.
- The public ID is an extension handle, not Pi's native session UUID. Keep both identities distinct.
- Generate the suffix from four cryptographically random bytes, represented by eight lowercase hexadecimal characters.
- The prefix is 1–64 lowercase ASCII letters/digits/hyphens, with alphanumeric ends. Fail allocation after 16 collisions.
- Preserve model, thinking level, agent prompt text, tool selection, working directory, and agent identity/source on resume.
- Capture resolved child settings, not just requested CLI arguments.
- The snapshot is immutable once published. It is authoritative for later launch settings, even if the definition is changed or deleted.
- Reject unknown IDs and concurrent use of one conversation.
- Do not automatically expire or steal a lease.
- Pi remains responsible for messages, tool history, compaction, and context reconstruction.
- Display and usage counters cover the **current invocation**, not replayed historical messages.
- No tests may use the user's real sessions or credentials.
- Leave `~/.pi/agent/extensions/subagent/` unchanged until approved; avoid loading both copies and registering two tools with the same name.
- No global workflow-policy changes, session-management UI, background jobs, or model-selection API in this feature.
- Use jj for all VCS operations, including inspection. Scope formatting to the current revision with `jj fix -s @`; never rewrite older revisions to format new work.
- Do not delegate further from an implementer. Do not seal before the controller has arranged independent review. No code fixes by the controller.
- The user permitted fresh reviewer conversations for this change only, carrying prior findings and fix diffs. Every fix still requires re-review. A repeated agent name is not conversation continuity.

## Review Focus

Each condition below has a regression test in its owning task:

1. **A valid JSON line that is not a valid native session entry:** fail before launching; do not let Pi silently discard history (Task 1).
2. **Controller crash while its child is still alive:** a second process must not reclaim its lease; normal cancellation must wait for actual closure (Tasks 1–2).
3. **A renamed/deleted agent, colliding project name, or changed default tool list:** resume uses saved provenance and resolved settings, not new discovery (Tasks 2–3).
4. **A bootstrap hook throws or consumes input without admitting a task:** no provider request, and the parent must not mistake exit code zero for success (Task 2).
5. **UTF-8 split across stdout chunks and IDs in capped/batch output:** preserve characters, per-task IDs, and clean `{previous}` text (Tasks 2–3).

---

## Starting state, workflow, and gate

- Imported baseline: `pxyxtyymrknx`.
- Design revision: `vwnuxlsolwyr`.
- Formatter setup: `qqsvrnluzusr`; reviewed, with the `.mjs` coverage finding fixed and re-reviewed.
- `npm run setup:jj` installs only the repo-local jj formatter configuration. Run `npm ci --ignore-scripts` first on a new checkout.
- Current format gate: `npm run format:check`. Task 1 extends the project gate to `npm run check` (format, types, tests).
- Preserve the isolated `/srv/code/pi-subagent` workspace. No Git worktree, push, install, or reload is required to execute the source plan.

The user authorized plan review using the `plan-reviewer` role and execution once it passes, applying `.claude/commands/review-plan.md` and `execute-plan.md` from Predator through the available Pi tools. Their Claude-only Agent/SendMessage calls are not available here; use the explicitly approved fresh-reviewer bootstrap exception with prior findings and diffs. The user-selected models below override the adapters' model aliases. Keep briefs, diffs, reports, and a progress ledger in `.superpowers/sdd/subagent-resumption/`. Inspect `jj status` and history before each dispatch. Do not use skill helper scripts that require Git operations.

| Group | Tasks | Deliverable                                   | Implementer model        | Reviewer model             |
| ----- | ----- | --------------------------------------------- | ------------------------ | -------------------------- |
| A     | 1     | Safe persistence and lease primitives, tested | `openai-codex/gpt-6-sol` | `openai-codex/gpt-6-astra` |
| B     | 2     | Guarded native Pi child lifecycle, tested     | `openai-codex/gpt-6-sol` | `openai-codex/gpt-6-astra` |
| C     | 3     | Public resume dispatch and UI, tested         | `openai-codex/gpt-6-sol` | `openai-codex/gpt-6-astra` |
| D     | 4     | Operator docs, full verification and review   | Controller               | `openai-codex/gpt-6-astra` |

These are explicit installed agent mappings: `implementer-sol` and `reviewer-astra`. Group B carries the most runtime risk and must not be downgraded to a mechanical transcription task. Each code task ends with its applicable gate and independent spec/quality review. The controller handles code findings through an implementer, then returns findings and the updated diff to review until clear.

After review and fresh verification, the controller seals each task with `jj describe -m` using its literal description below, then `jj new`. Record the resulting **change-id**, not its commit hash. There is no squash, rebase, or abandon step.

## File boundaries

| File                                 | Responsibility                                                                            |
| ------------------------------------ | ----------------------------------------------------------------------------------------- |
| `agents.ts`                          | Existing definition discovery; no persistence or resume lookup                            |
| `session-store.ts`                   | Paths, ID allocation, snapshot validation/publication, transcript preflight, leases       |
| `child-launch.ts`                    | Launch descriptor, CLI arguments, temp inputs, process closure/cancellation, JSON decoder |
| `child-bootstrap.ts`                 | Explicitly loaded extension; effective startup capture/check and input admission          |
| `results.ts`                         | Shared invocation types and pure output helpers extracted from `index.ts`                 |
| `dispatch.ts`                        | Request validation, task selection, consent, bounded scheduling, lease ownership          |
| `index.ts`                           | Tool registration, supported failure hook, existing TUI renderers with IDs                |
| `tests/session-store.test.ts`        | Store, malformed input, privacy, and cross-process lease tests                            |
| `tests/child-launch.test.ts`         | Bootstrap, child lifecycle, framing, and real CLI continuation                            |
| `tests/dispatch.test.ts`             | Modes, consent, batch errors, metadata, and renderer compatibility                        |
| `tests/helpers/fixtures.ts`          | Temporary roots and native-session test data                                              |
| `tests/helpers/pi-fixture.ts`        | Test CLI invocation and isolated environment construction                                 |
| `tests/fixtures/fixture-provider.ts` | Deterministic no-network provider for actual Pi subprocesses                              |
| `tests/fixtures/process-probe.mjs`   | Controlled output, signal, and lease subprocess probes                                    |
| `tsconfig.json`                      | Strict no-emit source/test type checking                                                  |
| `README.md`                          | Controller-owned usage, setup, limitations, installation and recovery                     |

Do not split the existing renderer into more modules just for this work. Moving process code and output types out of the large `index.ts` has a direct purpose: the launcher must be independently testable without constructing a TUI.

## Task 1: Safe persistent session store

**Files:** create `session-store.ts`, `tsconfig.json`, `tests/session-store.test.ts`, `tests/helpers/fixtures.ts`, `tests/fixtures/process-probe.mjs`; modify `package.json` and `package-lock.json`. Preserve the existing formatter configuration.

### Interfaces

Export these types and functions from `session-store.ts`. Other tasks consume these exact names and fields:

```typescript
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export interface AgentIdentity {
  name: string;
  source: "user" | "project";
  definitionPath: string;
  discoveryCwd: string;
  projectAgentsDir: string | null;
  cwd: string;
  systemPrompt: string;
}

export interface SavedConfig extends AgentIdentity {
  version: 1;
  id: string;
  piSessionId: string;
  provider: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  tools: string[];
}

export interface SessionPaths {
  root: string;
  id: string;
  dir: string;
  config: string;
  transcript: string;
  lock: string;
}

export interface SessionLease {
  readonly paths: SessionPaths;
  readonly token: string;
  recordChild(pid: number): Promise<void>;
  release(): Promise<void>;
}

export function sessionPaths(root: string, id: string): SessionPaths;
export function allocateSession(root: string, agentName: string, randomSuffix?: () => string): Promise<SessionPaths>;
export function acquireLease(paths: SessionPaths): Promise<SessionLease>;
export function prepareTranscript(lease: SessionLease): Promise<void>;
export function parseSavedConfig(value: unknown): SavedConfig;
export function readSavedConfig(paths: SessionPaths): Promise<SavedConfig>;
export function publishSavedConfig(paths: SessionPaths, ownerToken: string, config: SavedConfig): Promise<void>;
export function validateTranscript(paths: SessionPaths, config: SavedConfig): Promise<void>;
```

These are interface declarations, not empty implementation stubs to commit. `randomSuffix` is a narrow deterministic test seam; its production default uses `randomBytes(4).toString("hex")`. All persisted reads must validate before returning these types. Never cast unvalidated JSON straight to `SavedConfig`.

- [ ] **Step 1: Add the test/type gate and first failing tests.**

Pin direct development dependencies:

```json
{
  "@earendil-works/pi-agent-core": "0.87.1",
  "@earendil-works/pi-ai": "0.87.1",
  "@earendil-works/pi-coding-agent": "0.87.1",
  "@earendil-works/pi-tui": "0.87.1",
  "@types/node": "22.19.19",
  "tsx": "4.20.5",
  "typebox": "1.3.27",
  "typescript": "5.9.3"
}
```

Retain Prettier 3.6.2 and existing scripts. Add:

```json
{
  "test": "node --import tsx --test tests/*.test.ts",
  "typecheck": "tsc --noEmit",
  "check": "npm run format:check && npm run typecheck && npm test"
}
```

Use `npm install --ignore-scripts --save-dev --save-exact` with those exact package/version pairs. No npm lifecycle scripts, global installs, network model calls, or generated build output. `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["*.ts", "tests/**/*.ts"]
}
```

Write the first store tests before creating its implementation:

```typescript
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { allocateSession, acquireLease, sessionPaths } from "../session-store.ts";

test("allocation retries collisions; a lease excludes a second writer", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await allocateSession(root, "Reviewer", () => "a1b2c3d4");
  const suffixes = ["a1b2c3d4", "b1b2c3d4"];
  const second = await allocateSession(root, "Reviewer", () => suffixes.shift()!);
  assert.equal(first.id, "reviewer-a1b2c3d4");
  assert.equal(second.id, "reviewer-b1b2c3d4");
  const lease = await acquireLease(first);
  await assert.rejects(acquireLease(first), /busy/);
  await lease.release();
  await (await acquireLease(first)).release();
  for (const bad of ["../reviewer-a1b2c3d4", "/tmp/x", "reviewer-DEADBEEF", " reviewer-a1b2c3d4"])
    assert.throws(() => sessionPaths(root, bad), /invalid/i);
});
```

Run `node --import tsx --test tests/session-store.test.ts`; confirm a failure due to the missing implementation, not an unresolved dependency. Then add grouped cases for all rows below before the corresponding implementation step:

| Group          | Inputs and assertions                                                                                                                                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| IDs/paths      | Empty/non-ASCII names become a safe slug; 64-character cap; 16 collisions fail; traversal/separators/whitespace/uppercase suffix fail; unknown ID does not create a directory                                                                                |
| Privacy        | POSIX directories 0700 and owned files 0600; reject symlinked session directory, config, transcript, and lock owner; no secrets/environment fields in snapshot                                                                                               |
| Snapshot       | Version 1 accepted; wrong versions/types, duplicate tool names, relative cwd/source paths, project/user provenance mismatch, wrong public ID rejected; publication refuses overwrite and wrong lease token                                                   |
| Native history | Valid Pi-created session accepted; missing/empty/invalid header, mismatched cwd/native ID, malformed final line, `{}` entry, duplicate entry ID, or impossible parent reference rejected without changing file bytes                                         |
| Lease          | Two independent processes contend; release with changed token refuses to delete; repeated own release is harmless; existing ownerless/orphaned lock stays busy; child PID recorded; failed lock-owner initialization cleans up only its own unlaunched lease |

- [ ] **Step 2: Implement path/ID allocation and snapshot persistence.**

Use exclusive `mkdir` for the conversation and `.lock`. Create/check the trusted root once, then reject symlinks with `lstat` for conversation components and files. Validate path containment and use fixed filenames. Do not call recursive `mkdir` on a resume ID. Resolve/canonicalize cwd and source paths while creating `AgentIdentity`; the saved definition path need not still exist on resume.

The ID grammar and production suffix are:

```typescript
const ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?-[0-9a-f]{8}$/;
const suffix = () => randomBytes(4).toString("hex");
const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 64)
    .replace(/^-+|-+$/g, "") || "agent";
```

Validate injected suffixes too. Treat only `EEXIST` as a collision/busy result, and propagate permission/I/O errors with the operation and public ID.

Atomic immutable snapshot publication: validate content and lease token, write a private uniquely named temporary file in the conversation directory, then use an exclusive hard-link publication to `config.json` so an existing destination cannot be replaced. Remove the temporary link in `finally`. Use this only on the supported local filesystem. Mutable private lease-owner metadata can use write-to-temp plus atomic rename under its owned lock. Wrap same-process read/modify/write file operations with Pi's `withFileMutationQueue`; that does not replace the cross-process lease.

- [ ] **Step 3: Implement the native-history preflight and leases.**

Read and strictly parse every nonblank JSONL record before asking Pi to open the file. Require the first record to be a native v3 session header matching the saved native ID/cwd, and subsequent records to have valid common entry fields and current native type-specific required fields. Pin the supported entry contracts to `dist/core/session-manager.d.ts` and `docs/session-format.md` in Pi 0.87.1. Accept native custom/usage/compaction/context-edit entries and extra fields; reject unknown entry types for this pinned version rather than silently dropping them. Check IDs/parent references without rebuilding model context. Do not use Pi's permissive file parser alone as validation, and never repair a failed input.

The lease owner contains `token`, `controllerPid`, `acquiredAt`, and nullable `childPid`. `recordChild` and `release` check the token. Release removes only the owned lock directory, not config/history. A missing already-released own lock is harmless; a replacement owner's lock must survive. There is no age-based recovery.

`prepareTranscript` exclusively creates an empty 0600 file only for an allocated new session under its lease. Existing/unknown sessions cannot use that path. A separate process in `process-probe.mjs` imports the store through `node --import tsx`, reports lease acquisition over IPC, and holds it until explicitly released. Use IPC handshakes instead of sleeps for contention tests.

Run the focused store test after each group. Add native fixtures with `SessionManager` from Pi; construct records manually only for deliberately corrupt variants.

- [ ] **Step 4: Verify and submit for review.**

```bash
jj fix -s @
npm run check
jj diff --stat
```

All commands must succeed. The implementer writes its report with red/green evidence and leaves the change unsealed. Controller arranges review. Suggested description after approval: `Add validated persistent session storage and exclusive leases`.

## Task 2: Guarded child startup and native resumption

**Files:** create `child-launch.ts`, `child-bootstrap.ts`, `results.ts`, `tests/child-launch.test.ts`, `tests/helpers/pi-fixture.ts`, `tests/fixtures/fixture-provider.ts`; extend `tests/fixtures/process-probe.mjs`. Modify `index.ts` only to import the extracted shared types/output helpers without changing dispatch behavior yet.

**Consumes:** Task 1's `SessionPaths`, `SessionLease`, `AgentIdentity`, `SavedConfig`, and store functions.

### Interfaces

Move the existing `UsageStats`, `SingleResult`, `SubagentDetails`, `getFinalOutput`, `isFailedResult`, `getResultOutput`, and `truncateParallelOutput` definitions into `results.ts`; preserve existing fields. Add optional `conversationId`, `resumed`, and `resumable` to `SingleResult`, and optional `failed` to `SubagentDetails` for supported tool-result error signaling. Existing results without these fields stay valid.

`child-launch.ts` exports:

```typescript
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { SingleResult } from "./results.ts";
import type { AgentIdentity, SavedConfig, SessionLease, SessionPaths } from "./session-store.ts";

export type LaunchIntent =
  | {
      kind: "new";
      identity: AgentIdentity;
      requestedModel?: string;
      requestedThinking?: ThinkingLevel;
      requestedTools?: string[];
    }
  | { kind: "resume"; saved: SavedConfig };

export interface ChildRequest {
  lease: SessionLease;
  intent: LaunchIntent;
  task: string;
  step?: number;
}

export interface ChildRuntime {
  invocation: { command: string; prefixArgs: string[] };
  env: NodeJS.ProcessEnv;
  bootstrapPath: string;
  killGraceMs: number;
}

export function defaultChildRuntime(): ChildRuntime;
export function runChild(
  request: ChildRequest,
  runtime: ChildRuntime,
  signal?: AbortSignal,
  onUpdate?: (result: SingleResult) => void,
): Promise<SingleResult>;
```

`runChild` owns temporary inputs and process settlement, **not lease release**. Its promise cannot settle while a spawned child can still write the transcript. Failures after allocation return a failed `SingleResult` retaining its ID; an unexpected exception must also terminate/wait before escaping. `defaultChildRuntime()` sets `killGraceMs: 5000` and clones the parent's normal environment; test overrides supply an isolated environment and a short grace period without adding public tool parameters.

Use this private per-invocation descriptor/receipt protocol (JSON files in one 0700 temp directory, both 0600):

```typescript
export interface LaunchDescriptor {
  version: 1;
  token: string;
  paths: SessionPaths;
  intent: LaunchIntent;
  receiptPath: string;
}
export type StartupReceipt =
  | { version: 1; token: string; ready: true; piSessionId: string }
  | { version: 1; token: string; ready: false; error: string };
```

These two interfaces live in `child-launch.ts` as type exports; the bootstrap uses type-only imports to avoid starting parent-side behavior. Descriptor parsing and startup functions belong in `child-bootstrap.ts`, with named testable exports and a default extension factory. Keep bootstrap factory side effects restricted to its explicitly requested child process.

- [ ] **Step 1: Build the real CLI fixture and failing continuation test.**

`tests/helpers/pi-fixture.ts` creates a temporary HOME, agent directory, child cwd, and fixture provider extension. Set `HOME`, `PI_CODING_AGENT_DIR`, `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`, and `PI_TELEMETRY=0`; supply a sanitized env containing only required OS/runtime variables and fixture variables. Do not copy real auth, project settings, HOME context, or provider-key variables. Put the provider at the temporary agent directory's `extensions/fixture-provider.ts`, so both a fixture controller and its children discover it without inheriting arbitrary CLI extension flags. Use the pinned local package's `dist/cli.js`, not the test runner's `process.argv[1]`. Disable automatic compaction/retry/cache warming in fixture settings. Use a cwd beneath the temporary HOME and `--no-context-files` for direct fixture invocations; default children also stay under this empty temporary HOME, with no real context files.

The provider registers static `fixture/reviewer` and `fixture/other` models using `pi.registerProvider`, a literal dummy key, and a local `streamSimple` function. Give it zero costs and a 32768-token context window. The stream appends its received `context.messages`, selected model, and tool declarations to the fixture log, emits balanced `start`, `text_start`, `text_delta`, `text_end`, `done` events, then ends. It returns `first-answer` to the first user task and `follow-up-answer` when prior assistant history is present. Call `options.onPayload`/`onResponse` as required by Pi's provider contract; handle an aborted signal with a single terminal aborted event. No HTTP service or real credentials are needed.

Use `createAssistantMessageEventStream`, `getCurrentTools`, and `getCurrentSystemPrompt` from `@earendil-works/pi-ai`; system/tool state now lives in transcript messages, not obsolete `context.systemPrompt` or `context.tools` fields. The checked reference is Pi's `docs/custom-provider.md` and `examples/extensions/custom-provider-anthropic/index.ts`.

The main regression must make two actual, separate CLI child processes:

```typescript
test("a second child uses native history and frozen startup settings", async (t) => {
  const fixture = await createPiFixture(t);
  const paths = await allocateSession(fixture.root, "reviewer");
  const firstLease = await acquireLease(paths);
  await prepareTranscript(firstLease);
  const first = await runChild({ lease: firstLease, intent: fixture.newIntent, task: "first-task" }, fixture.runtime);
  await firstLease.release();
  assert.equal(first.exitCode, 0);
  assert.equal(getFinalOutput(first.messages), "first-answer");
  const saved = await readSavedConfig(paths);
  await fixture.changeDefaultsAndRemoveDefinition();
  const secondLease = await acquireLease(paths);
  const second = await runChild(
    { lease: secondLease, intent: { kind: "resume", saved }, task: "follow-up-task" },
    fixture.runtime,
  );
  await secondLease.release();
  assert.equal(second.conversationId, first.conversationId);
  assert.equal(getFinalOutput(second.messages), "follow-up-answer");
  assert.equal(second.usage.turns, 1);
  const calls = await fixture.providerCalls();
  assert.equal(calls.length, 2);
  assert.match(JSON.stringify(calls[1].messages), /first-task/);
  assert.match(JSON.stringify(calls[1].messages), /first-answer/);
  assert.equal((await readSavedConfig(paths)).piSessionId, saved.piSessionId);
});
```

`createPiFixture(t)` is defined in this task, returns the named properties/methods above, and registers cleanup with `t.after`. `newIntent` contains an actual Markdown definition path created by the helper, `fixture/reviewer:high`, and omitted tools to exercise default resolution. `changeDefaultsAndRemoveDefinition()` deletes that Markdown and changes fixture settings to the other model, lower thinking, and a different default tool list. `providerCalls()` parses the private fixture log. Use `try/finally` lease cleanup in the final tests so failed assertions cannot strand children.

Run `node --import tsx --test tests/child-launch.test.ts` and observe failure before implementing the launcher. Add these grouped regressions:

| Group                   | Assertions                                                                                                                                                                                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Effective configuration | Capture alias as exact provider/model, clamped thinking, actual default tool names, and prompt text; resume preserves them after defaults/definition changes; empty saved tools stay empty; missing model/tool or unsupported thinking makes zero provider calls |
| Bootstrap failure       | Missing/broken explicit helper, malformed descriptor, snapshot publication error, receipt write error, and mismatch all prevent task admission; absent/error receipt is failure even if child exits zero                                                         |
| Session integrity       | Resume validates before spawn; a native compaction entry made with `SessionManager.appendCompaction` is reconstructed by Pi; only current output/usage reaches the result                                                                                        |
| Process lifecycle       | Already-aborted signal starts no child; spawn failure retains ID; child ignoring SIGTERM receives SIGKILL; promise stays pending until closure; cleanup removes timers/listeners/temp inputs; a throwing update callback cannot orphan the child                 |
| Framing                 | Split a four-byte Unicode character between chunks; LF/CRLF records; final buffered record; U+2028 inside a JSON string; malformed protocol record yields a diagnostic rather than fabricated success                                                            |

- [ ] **Step 2: Implement fail-closed bootstrap and configuration capture.**

The factory registers a private string flag `--subagent-launch <absolute-descriptor-path>` and validates that descriptor at load time. Add the input handler synchronously; all admitted tasks pass through it. The explicit helper's import/factory errors become fatal CLI startup diagnostics in Pi 0.87.1 (`dist/main.js`, runtime diagnostics before `runPrintMode`). Test that fact; it must not be assumed from a mocked API.

At the input boundary, read `ctx.model`, `pi.getThinkingLevel()`, `pi.getActiveTools()`, and `ctx.sessionManager.getHeader()`. Confirm canonical cwd/session path and the lease token. On new startup, build/publish version-1 `SavedConfig` from the launch identity and **effective** settings. On resume, verify exact saved model/thinking/tools and original native identity; do not republish config. Compare tool sets without treating order as a capability change. Unknown/missing tools cannot be silently ignored.

The failure control flow must return `handled`, not throw through a hook Pi catches:

```typescript
pi.on("input", async (_event, ctx) => {
  try {
    const config = await captureOrVerifyStartup(pi, ctx, descriptor);
    await writeStartupReceipt(descriptor.receiptPath, {
      version: 1,
      token: descriptor.token,
      ready: true,
      piSessionId: config.piSessionId,
    });
    return { action: "continue" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await writeStartupReceipt(descriptor.receiptPath, {
        version: 1,
        token: descriptor.token,
        ready: false,
        error: message,
      });
    } catch {
      // No receipt also fails closed in the parent; never admit this input.
    }
    try {
      process.stderr.write(`Subagent startup failed: ${message}\n`);
    } catch {
      // Reporting failure must not turn rejection into admitted input.
    }
    return { action: "handled" };
  }
});
```

Define `captureOrVerifyStartup(pi: ExtensionAPI, ctx: ExtensionContext, descriptor: LaunchDescriptor): Promise<SavedConfig>` and `writeStartupReceipt(path: string, receipt: StartupReceipt): Promise<void>` in `child-bootstrap.ts`. The latter atomically publishes a private per-run receipt. Scope the entire check/publication inside the catch above. Never throw from its error-reporting path in a way that lets the runner continue the original input; guard a failing stderr write too. Only the explicit bootstrap reads the launch flag; no persistent global state or inherited bootstrap environment marker is needed.

A receipt is necessary because a handled input may lead to CLI exit zero. Its version/token/native ID must match the invocation and snapshot; the parent cannot infer readiness from arbitrary stdout or an old `config.json`.

- [ ] **Step 3: Implement child arguments, event decoding, and settlement.**

New and resumed runs both use `--mode json -p --session <paths.transcript> --session-dir <paths.dir> --extension <bootstrapPath> --subagent-launch <descriptorPath>`. Use a private prompt file with `--append-system-prompt`, passing the original text even if it resembles a filesystem path. Append `Task: ${task}` as one argument, preserving the existing task envelope. No shell interpolation.

Before spawning a resume child, `runChild` calls `validateTranscript` with the saved config while its caller still owns the lease. This is a defensive boundary for direct internal callers/tests; dispatch also preflights before asking for consent. Neither check opens or mutates history through Pi. For new calls use the requested model/thinking/tools precedence from the intent. For resume supply the exact saved provider/model, saved thinking, and `--tools` allowlist; use `--no-tools` for an empty list. The helper checks that Pi actually selected them. Do not propagate `--approve` or copy parent command-line resource flags by guessing. Use the existing executable-discovery intent, but do not treat an arbitrary Node test script as the Pi CLI; tests pass an explicit `ChildRuntime`.

Use `StringDecoder("utf8")` and split only on LF. Parse `message_end` as the authoritative completed-message event. Preserve complete current results and usage accounting; do not replay the session file into `messages`. Recognize terminal provider error/aborted states even when JSON-mode process exit is zero. Validate the startup receipt after closure before treating a run as successful. Include the conversation ID in the first progress update before spawn and all later failure results.

Settle around the process `close` event. Track actual closure separately from `proc.killed`. Record the child PID under the owned lease immediately after spawn. Cancellation sends SIGTERM, starts a `runtime.killGraceMs` timer, sends SIGKILL if not closed, and clears the timer/listener only after settlement. An `error` event's diagnostic is retained; do not release the lease while a child can still run. If setup/output handling fails after spawn, stop and wait for that child before returning the error. Per-run temp inputs are removed in the outer `finally`.

The test process probe implements explicit modes for fragmented stdout, exit-before-response, and ignoring SIGTERM. Tests wait for its ready handshake before sending abort; use a short injected grace interval, not a five-second sleep per case.

- [ ] **Step 4: Verify and submit for review.**

```bash
jj fix -s @
npm run check
```

The real CLI tests are part of the normal suite and use no paid calls. Verify the existing public tool still behaves as its baseline in this task; Task 3 connects the new runner. Report red/green, native-history assertions, and zero-provider-call evidence for each bootstrap failure. Suggested description after review: `Add guarded persistent Pi child execution`.

## Task 3: Resume dispatch, consent, and ID-aware output

**Files:** create `dispatch.ts`, `tests/dispatch.test.ts`; modify `index.ts`, `results.ts`; extend `tests/helpers/pi-fixture.ts` and `tests/fixtures/fixture-provider.ts` for a controller-mode fixture. Keep `agents.ts` discovery semantics unchanged.

**Consumes:** Task 1 storage/leases, Task 2 `runChild`, `defaultChildRuntime`, `LaunchIntent`, and result helpers.

### Interfaces

Export the public schema from `dispatch.ts` and derive its TypeScript type with TypeBox `Static`. Task items have optional `agent`/`resume`/`cwd` plus required `task`; runtime validation enforces exactly one selector. Single mode uses the same fields at the top level. Preserve the current `agentScope` enum/default, confirmation option, task limits, and task descriptions while documenting resume explicitly.

```typescript
export type SelectedTask =
  | { kind: "new"; agent: string; task: string; cwd?: string }
  | { kind: "resume"; id: string; task: string };

export interface ValidatedCall {
  mode: "single" | "parallel" | "chain";
  tasks: SelectedTask[];
  agentScope: AgentScope;
  confirmProjectAgents: boolean;
}

export function validateCall(params: SubagentParams): ValidatedCall;
export function executeSubagent(
  params: SubagentParams,
  ctx: ExtensionContext,
  signal?: AbortSignal,
  onUpdate?: (partial: AgentToolResult<SubagentDetails>) => void,
): Promise<AgentToolResult<SubagentDetails>>;
```

`AgentScope` comes from `agents.ts`; `SubagentParams` is the schema-derived type; the other types come from Pi/`results.ts`. Test the exported validator directly and exercise real dispatch with the isolated fixture. Keep pure normalization separate from filesystem/process work. Unknown IDs are runtime failures with their requested ID, not a reason to create a session.

- [ ] **Step 1: Write the validator and orchestration failures first.**

```typescript
test("a task has one selector and parallel IDs must be unique", () => {
  assert.equal(validateCall({ resume: "reviewer-a1b2c3d4", task: "follow-up" }).tasks[0].kind, "resume");
  for (const params of [
    { agent: "reviewer", resume: "reviewer-a1b2c3d4", task: "x" },
    { resume: "reviewer-a1b2c3d4", task: "x", cwd: "/tmp" },
    { tasks: [] },
    { agent: "reviewer", task: "x", chain: [] },
    {
      tasks: [
        { resume: "reviewer-a1b2c3d4", task: "one" },
        { resume: "reviewer-a1b2c3d4", task: "two" },
      ],
    },
  ])
    assert.throws(() => validateCall(params));
  assert.equal(
    validateCall({
      chain: [
        { resume: "reviewer-a1b2c3d4", task: "one" },
        { resume: "reviewer-a1b2c3d4", task: "two" },
      ],
    }).tasks.length,
    2,
  );
});
```

Run the focused test and verify failure before implementing dispatch. Group remaining tests:

| Group                  | Assertions                                                                                                                                                                                                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full validation        | Missing/blank selectors/task; both selectors even if one blank; selectors with surrounding whitespace; conflicting top-level fields; top-level cwd in batch; nine parallel tasks; duplicate resume IDs produce no allocation/spawn                                                  |
| Scheduling             | At most four parallel children; result order follows request order; mixed new/resume batch; same agent gets different new IDs; a failed task retains other outputs; aborted queue never starts later tasks                                                                          |
| Chains                 | Sequential same-ID resume works; stop at first failure; all executed IDs visible; `{previous}` is only final assistant text; no skipped-step results presented as executed                                                                                                          |
| Frozen source/consent  | Resume still works with deleted/colliding definition and changed agentScope; no discovery on resume-only call; saved project provenance shown; different saved project asks even if controller is trusted; false confirmation option suppresses prompt; no-UI behavior matches spec |
| Output/UI              | ID in single/parallel/chain progress and final headers, including failures and truncation; current-invocation usage only; both TUI views; old details lacking new fields render safely; narrow terminal and Unicode output                                                          |
| Actual error semantics | Runtime single/chain failures preserve details and become true tool errors through the supported hook; partial parallel failure is a batch result; invalid whole call throws before dispatch                                                                                        |

Use a narrow test registration adapter that records `registerTool`/`on` handlers from `index.ts` and supplies only the context operations the tool uses. Type its recorded tool/schema and callbacks; do not add production dependency injection solely to mimic every Pi API. For actual error semantics, extend the deterministic provider with a controller mode selected by an initial `controller-case:` user prompt. It emits one `subagent` tool call, observes the resulting tool message, and terminates. Child prompts start with `Task:` and must remain in worker mode; do not select controller mode with an environment flag that children would inherit. This exercises Pi's real `tool_result` hook, not only a mocked returned object.

- [ ] **Step 2: Implement selection, consent, and owned execution.**

`validateCall` rejects field presence conflicts before effects; it does not silently trim/repair IDs or agent names. Preserve task text after confirming it is nonblank. A resume-only call skips `discoverAgents`. In a mixed call discover only to resolve new selections; resumes read the saved identity, never a same-named discovered definition.

For each new task: form canonical `AgentIdentity`, confirm project-agent use as needed, allocate, acquire, prepare transcript, create new intent using the baseline precedence, run child, finally release. For resume: derive validated paths without creation, acquire, read snapshot, validate history and cwd, confirm using saved provenance, run saved intent, finally release. Return per-task failure records for lookup/consent/runtime errors so batch results retain other tasks. At no point can an error path convert resume into allocation.

The core ownership shape is:

```typescript
const lease = await acquireLease(paths);
try {
  const result = await runChild({ lease, intent, task, step }, runtime, signal, publishUpdate);
  return result;
} finally {
  await lease.release();
}
```

Compute `intent` under this lease on resume. A failed `release()` is a failure diagnostic, not successful completion. Use `defaultChildRuntime()` in production. Tests isolate the parent Pi environment through a fresh fixture controller process rather than relying on mutating a shared global environment mid-test.

For project consent, a controller trust check only skips the prompt if its canonical cwd matches **both** the saved discovery cwd and saved child cwd. Otherwise, when UI is available, ask with the saved name, source path, and child cwd unless confirmation is explicitly false. Without UI, preserve baseline no-extra-dialog behavior; this grants no automatic resource trust to the child. User agents do not acquire a new project-definition prompt.

Use a bounded worker loop for parallel tasks, checking abort before taking the next item. Repeated IDs within a chain are allowed only because each completed invocation releases its lease before the next begins. Do not launch any task for a syntactically invalid batch. A runtime unknown/busy ID is a per-task failure, not an all-or-nothing batch transaction.

- [ ] **Step 3: Preserve result details and use the supported failure hook.**

Throw for invalid top-level calls before any task starts. For started single/chain failures, return their full details with `failed: true`, then mark the result as an error through Pi's supported `tool_result` hook. This avoids losing IDs/details through the runtime's generic thrown-error conversion:

```typescript
pi.on("tool_result", (event) => {
  if (event.toolName !== "subagent") return;
  const details = event.details;
  if (details && typeof details === "object" && "failed" in details && details.failed === true)
    return { isError: true };
});
```

Partial parallel failure has explicit per-task status and `failed: false`; if all parallel tasks fail, set `failed: true`. Do not return an unsupported `isError` field from `execute` and assume Pi uses it. The hook is stateless; no map of pending tool calls is required. It must leave unrelated tools and old result shapes alone.

Update `getFinalOutput` callers so metadata never contaminates chain substitution. Put conversation ID and `new`/`resumed` status outside capped output bodies. Include executed chain IDs even if only the last assistant answer is returned as the main content. Extend the existing renderers, retaining optional-field fallbacks for pre-feature results. Failed allocated-but-uninitialized sessions must explicitly say `not resumable`.

- [ ] **Step 4: Verify and submit for review.**

```bash
jj fix -s @
npm run check
```

Report the actual CLI controller test showing a marked tool error with preserved details, mixed-batch and chained-resume evidence, and old-renderer compatibility. Review the whole connected path, not only schema changes. Suggested description after approval: `Expose persistent resume in single parallel and chain dispatch`.

## Task 4: Controller documentation and whole-change acceptance

**Owner:** controller, not an implementation subagent.

**Files:** create `README.md`; update this plan's checkboxes/evidence only after the corresponding work and review pass. If implementation shows a design change is necessary, discuss it and update the spec explicitly; do not silently weaken it to match code.

- [ ] **Step 1: Write operator documentation against implemented behavior.**

README sections: purpose and Pi 0.87.1 support; `npm ci --ignore-scripts`, `npm run setup:jj`, `jj fix -s @`, `npm run check`; new/resume/single/parallel/chain examples; saved configuration versus mutable environment; default and overridden storage roots; private-data warning; no retroactive recovery of old ephemeral runs; busy/error/partial initialization diagnostics; and manual stale-lease recovery.

Document recovery as inspection first: read the lock owner, verify controller and child have stopped, and only then remove that ID's `.lock` directory. Never recommend removing a busy lease based on age alone. Do not delete the transcript or snapshot to make a resume succeed. Warn that external tool effects may already have happened before an interrupted run.

Document installation as a **separate approved operation**: replace or point the existing extension directory to the complete source directory, not only `index.ts` (it now imports sibling modules); avoid loading both copies; reload/restart Pi and verify its exposed tool schema contains `resume`. Preserve a backup of the previous installed files. Do not perform those actions while writing docs.

- [ ] **Step 2: Run controller-owned final checks and seal the documentation.**

```bash
jj fix -s @
npm run check
jj diff --summary
```

Verify that tests ran, rather than accepting an empty filter. No live/paid smoke run or installation occurs without approval. Record the source completion evidence separately from deployed verification. Suggested description: `Document subagent resume usage and recovery`.

- [ ] **Step 3: Whole-change independent review and fix loop.**

The controller supplies the original baseline through the top-of-stack jj diff, this spec/plan, implementation reports, and actual gate results to `reviewer-astra` on `openai-codex/gpt-6-astra`. Review source and README together. For each finding, fix through an implementer (controller fixes docs), then re-run the affected gate and re-review under the explicit bootstrap exception until no findings remain. Do not substitute an implementer's assurance for review.

- [ ] **Step 4: Report completion or perform separately approved installation verification.**

Completion report names stable jj change-ids, tests, and whether installation/reload occurred. If the user approves installation, the controller runs the real new-reviewer/follow-up smoke test and checks identical public/native session IDs and retained history. Do not declare general workflow capability from source-only tests or from this task's reviewer-continuity exception.

## Self-review coverage

| Spec area                                      | Owner and proof                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| §§1–2 intent/native history                    | Task 2 real two-process continuation; Task 3 controller dispatch                      |
| §3 selectors/all modes/IDs                     | Task 3 validation, scheduler, chain, output/UI tests                                  |
| §4 safe IDs/storage/snapshot                   | Task 1 storage/lease checks; Task 2 actual resolved-config capture                    |
| §5 native lifecycle/fail-closed startup        | Task 2 CLI fixture, receipt protocol, missing-helper and zero-provider-call tests     |
| §6 concurrent writers/cancellation/failures    | Task 1 independent-process lease test; Task 2 settlement tests; Task 3 batch failures |
| §7 provenance/compatibility                    | Task 3 consent/default changes/legacy renderer tests                                  |
| §8 automated acceptance                        | `npm run check`; Tasks 1–3 grouped tests                                              |
| §§8–9 deployed verification/non-goals/workflow | Task 4 docs, separate installation gate, final review                                 |

Self-review completed before handoff: checked spec coverage above, interface names/types across all three code tasks, and ownership of the five Review Focus regressions. Corrected fixture-provider discovery so default children load the test provider, separated fixture controller prompts from worker prompts, made the bootstrap's diagnostic path fail closed, and made resume preflight responsibility explicit. Verified the failure-hook contract against Pi 0.87.1's exported types and runtime error conversion. The plan remains limited to native-session resumption; no additional agent orchestration features are authorized.
