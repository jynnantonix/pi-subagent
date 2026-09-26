import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	allocateSession,
	acquireLease,
	prepareTranscript,
	readSavedConfig,
	validateTranscript,
} from "../session-store.ts";
import { runChild } from "../child-launch.ts";
import { getFinalOutput } from "../results.ts";
import { createPiFixture } from "./helpers/pi-fixture.ts";

// Losing native --session persistence or replaying old output breaks this test.
test("a second child uses native history and frozen startup settings", async (t) => {
	const fixture = await createPiFixture(t);
	const paths = await allocateSession(fixture.root, "reviewer");
	const firstLease = await acquireLease(paths);
	let first;
	try {
		await prepareTranscript(firstLease);
		first = await runChild({ lease: firstLease, intent: fixture.newIntent, task: "first-task" }, fixture.runtime);
	} finally {
		await firstLease.release();
	}
	assert.equal(first.exitCode, 0, first.stderr);
	assert.equal(getFinalOutput(first.messages), "first-answer");
	const saved = await readSavedConfig(paths);
	assert.equal(saved.id, paths.id);
	assert.equal(saved.provider, "fixture");
	assert.equal(saved.model, "reviewer");
	assert.equal(saved.thinkingLevel, "high");
	assert.deepEqual(saved.tools, ["read", "grep"]);
	assert.equal(saved.systemPrompt, "Fixture reviewer prompt.\n");
	await fixture.changeDefaultsAndRemoveDefinition();
	const secondLease = await acquireLease(paths);
	let second;
	try {
		second = await runChild(
			{ lease: secondLease, intent: { kind: "resume", saved }, task: "follow-up-task" },
			fixture.runtime,
		);
	} finally {
		await secondLease.release();
	}
	assert.equal(second.exitCode, 0, second.stderr);
	assert.equal(second.conversationId, first.conversationId);
	assert.equal(getFinalOutput(second.messages), "follow-up-answer");
	assert.equal(second.usage.turns, 1);
	const calls = await fixture.providerCalls();
	assert.equal(calls.length, 2);
	assert.match(JSON.stringify(calls[1].messages), /first-task/);
	assert.match(JSON.stringify(calls[1].messages), /first-answer/);
	assert.equal(calls[1].model, "fixture/reviewer");
	assert.deepEqual(calls[1].tools, ["read", "grep"]);
	assert.match(calls[1].systemPrompt, /Fixture reviewer prompt/);
	assert.equal((await readSavedConfig(paths)).piSessionId, saved.piSessionId);
});

// Removing the spawn marker lets the discovered main extension register subagent in new and resumed children.
test("new and resumed Pi children exclude subagent without changing the parent environment", async (t) => {
	const fixture = await createPiFixture(t);
	fixture.env.PI_SUBAGENT = "0";
	const parentMarker = process.env.PI_SUBAGENT;
	const runtime = {
		...fixture.runtime,
		invocation: {
			...fixture.runtime.invocation,
			prefixArgs: [
				...fixture.runtime.invocation.prefixArgs,
				"--extension",
				resolve(import.meta.dirname, "../index.ts"),
			],
		},
	};
	const inventory = join(fixture.home, "child-tools.jsonl");
	await writeFile(
		join(fixture.agentDir, "extensions/inventory.ts"),
		`import { appendFileSync } from "node:fs";
export default (pi) => pi.on("input", () => appendFileSync(${JSON.stringify(inventory)}, JSON.stringify({ marker: process.env.PI_SUBAGENT, tools: pi.getAllTools().map((tool) => tool.name) }) + "\\n"));`,
	);
	const { paths, result } = await newRun(fixture, fixture.newIntent, runtime);
	assert.equal(result.exitCode, 0, result.stderr);
	assert.equal(getFinalOutput(result.messages), "first-answer");
	const initial = await readSavedConfig(paths);
	assert.deepEqual(initial.tools, ["read", "grep"]);
	const next = await resumed(fixture, paths, runtime);
	assert.equal(next.exitCode, 0, next.stderr);
	assert.equal(next.conversationId, paths.id);
	assert.equal(getFinalOutput(next.messages), "follow-up-answer");
	assert.equal((await readSavedConfig(paths)).piSessionId, initial.piSessionId);
	const calls = await fixture.providerCalls();
	assert.equal(calls.length, 2);
	assert.match(JSON.stringify(calls[1].messages), /first-task|first-answer/);
	assert.deepEqual(
		calls.map((call) => call.tools),
		[
			["read", "grep"],
			["read", "grep"],
		],
	);
	const inventories = (await readFile(inventory, "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.deepEqual(
		inventories.map((entry) => entry.marker),
		["1", "1"],
	);
	for (const entry of inventories) assert.equal(entry.tools.includes("subagent"), false);
	assert.equal(fixture.env.PI_SUBAGENT, "0");
	assert.equal(process.env.PI_SUBAGENT, parentMarker);

	// An old saved tool list must still fail the frozen startup check, not be filtered.
	await writeFile(paths.config, JSON.stringify({ ...initial, tools: ["read", "grep", "subagent"] }));
	const rejected = await resumed(fixture, paths, runtime);
	assert.notEqual(rejected.exitCode, 0);
	assert.match(rejected.stderr, /mismatch|unknown|unavailable/i);
	assert.equal((await fixture.providerCalls()).length, 2);
});

async function newRun(
	fixture: Awaited<ReturnType<typeof createPiFixture>>,
	intent = fixture.newIntent,
	runtime = fixture.runtime,
	task = "first-task",
) {
	const paths = await allocateSession(fixture.root, "reviewer");
	const lease = await acquireLease(paths);
	try {
		await prepareTranscript(lease);
		return { paths, result: await runChild({ lease, intent, task }, runtime) };
	} finally {
		await lease.release();
	}
}
async function resumed(
	fixture: Awaited<ReturnType<typeof createPiFixture>>,
	paths: Awaited<ReturnType<typeof allocateSession>>,
	runtime = fixture.runtime,
) {
	const lease = await acquireLease(paths);
	try {
		return await runChild(
			{ lease, intent: { kind: "resume", saved: await readSavedConfig(paths) }, task: "follow-up-task" },
			runtime,
		);
	} finally {
		await lease.release();
	}
}

// Dropping catalog membership checks admits synthetic fallback models and calls the provider.
test("catalog absence blocks both new and resumed invocations without a provider call", async (t) => {
	const fixture = await createPiFixture(t);
	const { paths, result } = await newRun(fixture);
	assert.equal(result.exitCode, 0, result.stderr);
	fixture.env.FIXTURE_REMOVE_REVIEWER = "1";
	const before = (await fixture.providerCalls()).length;
	const resume = await resumed(fixture, paths);
	assert.notEqual(resume.exitCode, 0);
	assert.equal(resume.conversationId, paths.id);
	const missing = await newRun(fixture);
	assert.notEqual(missing.result.exitCode, 0);
	await assert.rejects(readSavedConfig(missing.paths));
	assert.equal((await fixture.providerCalls()).length, before);
});

// A ready receipt alone must not count as a successful response when another handler consumes input.
test("a discovered handler can intercept after ready receipt without false success", async (t) => {
	const fixture = await createPiFixture(t);
	await writeFile(
		join(fixture.agentDir, "extensions/intercept.ts"),
		'export default (pi) => { pi.on("input", () => ({ action: "handled" })); };',
	);
	const { result } = await newRun(fixture);
	assert.notEqual(result.exitCode, 0);
	assert.match(result.errorMessage!, /completed assistant/i);
	assert.ok(result.conversationId);
	assert.equal((await fixture.providerCalls()).length, 0);
});

// An empty text block is still a complete assistant response, not a missing task.
test("empty assistant text completes when Pi settles", async (t) => {
	const fixture = await createPiFixture(t);
	fixture.env.FIXTURE_EMPTY_TEXT = "1";
	const { result } = await newRun(fixture);
	assert.equal(result.exitCode, 0, result.stderr);
	assert.equal(getFinalOutput(result.messages), "");
	assert.equal(result.usage.turns, 1);
});

// Changing the original transcript or native identity cannot silently open a replacement session.
test("resume rejects corrupt history before spawn and Pi reconstructs native compaction", async (t) => {
	const fixture = await createPiFixture(t);
	const { paths, result } = await newRun(fixture);
	assert.equal(result.exitCode, 0, result.stderr);
	const session = SessionManager.open(paths.transcript);
	const entry = session.getEntries().find((item) => item.type === "message" && item.message.role === "user");
	assert.ok(entry);
	session.appendCompaction("native-compaction-summary", entry.id, 100);
	await validateTranscript(paths, await readSavedConfig(paths));
	const next = await resumed(fixture, paths);
	assert.equal(next.exitCode, 0, next.stderr);
	assert.match(JSON.stringify((await fixture.providerCalls())[1].messages), /native-compaction-summary/);
	assert.equal(next.usage.turns, 1);
	const original = await readFile(paths.transcript, "utf8");
	await appendFile(paths.transcript, "{");
	const invalid = await resumed(fixture, paths);
	assert.notEqual(invalid.exitCode, 0);
	assert.match(invalid.stderr, /truncated|invalid/i);
	assert.equal((await fixture.providerCalls()).length, 2);
	await writeFile(paths.transcript, original);
});

// A caller-provided modified snapshot must not replace persisted authority.
test("resume refuses changed saved settings before a model call", async (t) => {
	const fixture = await createPiFixture(t);
	const { paths, result } = await newRun(fixture);
	assert.equal(result.exitCode, 0, result.stderr);
	const saved = await readSavedConfig(paths);
	const lease = await acquireLease(paths);
	try {
		const changed = await runChild(
			{ lease, intent: { kind: "resume", saved: { ...saved, model: "other" } }, task: "follow-up-task" },
			fixture.runtime,
		);
		assert.notEqual(changed.exitCode, 0);
		assert.match(changed.stderr, /snapshot|saved/i);
		assert.equal((await fixture.providerCalls()).length, 1);
	} finally {
		await lease.release();
	}
});

// Spawn and cancellation must retain the ID and not release a live writer.
test("aborted, failed-spawn, and stubborn children settle only after process close", async (t) => {
	const fixture = await createPiFixture(t);
	const { paths, result } = await newRun(fixture);
	assert.equal(result.exitCode, 0, result.stderr);
	const saved = await readSavedConfig(paths);
	const already = new AbortController();
	already.abort();
	const lease = await acquireLease(paths);
	try {
		const noChild = await runChild(
			{ lease, intent: { kind: "resume", saved }, task: "not-started" },
			fixture.runtime,
			already.signal,
		);
		assert.match(noChild.stderr, /aborted/i);
		assert.equal(JSON.parse(await readFile(join(paths.lock, "owner.json"), "utf8")).childPid, null);
	} finally {
		await lease.release();
	}
	const missing = await resumed(fixture, paths, {
		...fixture.runtime,
		invocation: { command: join(fixture.home, "no-cli"), prefixArgs: [] },
	});
	assert.notEqual(missing.exitCode, 0);
	assert.equal(missing.conversationId, paths.id);
	assert.match(missing.stderr, /ENOENT|spawn/i);
	const controller = new AbortController();
	const stubbornRuntime = {
		...fixture.runtime,
		invocation: {
			command: process.execPath,
			prefixArgs: [resolve(import.meta.dirname, "fixtures/process-probe.mjs"), "ignore-term"],
		},
	};
	const busyLease = await acquireLease(paths);
	let finished = false;
	let promise: ReturnType<typeof runChild> | undefined;
	try {
		promise = runChild(
			{ lease: busyLease, intent: { kind: "resume", saved }, task: "wait" },
			stubbornRuntime,
			controller.signal,
		).then((value) => {
			finished = true;
			return value;
		});
		// Probe's ready handshake is a file written only after its SIGTERM handler is installed.
		const marker = join(fixture.home, "probe-ready");
		for (let i = 0; i < 100; i++) {
			if (
				await readFile(marker).then(
					() => true,
					() => false,
				)
			)
				break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(await readFile(marker, "utf8"), "ready");
		controller.abort();
		assert.equal(finished, false);
		await assert.rejects(acquireLease(paths), /busy/);
		const cancelled = await promise;
		assert.notEqual(cancelled.exitCode, 0);
		assert.equal(cancelled.conversationId, paths.id);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		const tempDescriptor = await readFile(join(fixture.home, "probe-descriptor"), "utf8");
		await assert.rejects(readFile(tempDescriptor), /ENOENT/);
	} finally {
		controller.abort();
		try {
			if (promise) await promise;
		} finally {
			await busyLease.release();
		}
	}
	assert.equal((await fixture.providerCalls()).length, 1);
});

// A readiness assertion failure must cancel and settle the child before releasing ownership.
test("readiness failure still settles a stubborn child before releasing its lease", async (t) => {
	const fixture = await createPiFixture(t);
	const { paths, result } = await newRun(fixture);
	assert.equal(result.exitCode, 0, result.stderr);
	const saved = await readSavedConfig(paths);
	const controller = new AbortController();
	const lease = await acquireLease(paths);
	const runtime = {
		...fixture.runtime,
		invocation: {
			command: process.execPath,
			prefixArgs: [resolve(import.meta.dirname, "fixtures/process-probe.mjs"), "ignore-term"],
		},
	};
	let running: ReturnType<typeof runChild> | undefined;
	let finished = false;
	let closedBeforeRelease = false;
	let ready = false;
	try {
		running = runChild({ lease, intent: { kind: "resume", saved }, task: "wait" }, runtime, controller.signal).then(
			(value) => {
				finished = true;
				return value;
			},
		);
		const marker = join(fixture.home, "probe-ready");
		for (let i = 0; i < 100; i++) {
			if (
				await readFile(marker).then(
					() => true,
					() => false,
				)
			)
				break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(await readFile(marker, "utf8"), "ready");
		ready = true;
		assert.equal(await readFile(join(fixture.home, "missing-ready"), "utf8"), "ready");
	} catch (error) {
		assert.match(String(error), /ENOENT/);
	} finally {
		controller.abort();
		try {
			if (running) await running;
			closedBeforeRelease = finished;
		} finally {
			await lease.release();
		}
	}
	assert.equal(ready, true);
	assert.equal(closedBeforeRelease, true);
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	const reacquired = await acquireLease(paths);
	await reacquired.release();
});

// Startup failures must fail closed even when Pi print mode exits zero.
test("missing helper, broken helper, publication, receipt, and effective-tool mismatch block provider calls", async (t) => {
	const fixture = await createPiFixture(t);
	const missing = await newRun(fixture, fixture.newIntent, {
		...fixture.runtime,
		bootstrapPath: join(fixture.home, "absent-bootstrap.ts"),
	});
	assert.notEqual(missing.result.exitCode, 0);
	assert.equal(missing.result.conversationId, missing.paths.id);
	assert.match(missing.result.stderr, /extension|receipt|load/i);
	assert.equal((await fixture.providerCalls()).length, 0);
	const brokenPath = join(fixture.home, "broken.ts");
	await writeFile(brokenPath, "throw new Error('broken bootstrap import')");
	const broken = await newRun(fixture, fixture.newIntent, { ...fixture.runtime, bootstrapPath: brokenPath });
	assert.notEqual(broken.result.exitCode, 0);
	assert.match(broken.result.stderr, /broken bootstrap import/i);
	assert.equal((await fixture.providerCalls()).length, 0);
	const brokenFactory = join(fixture.home, "factory.ts");
	await writeFile(brokenFactory, "export default () => { throw new Error('broken bootstrap factory') }");
	const factory = await newRun(fixture, fixture.newIntent, { ...fixture.runtime, bootstrapPath: brokenFactory });
	assert.notEqual(factory.result.exitCode, 0);
	assert.match(factory.result.stderr, /broken bootstrap factory/i);
	assert.equal((await fixture.providerCalls()).length, 0);
	await writeFile(
		join(fixture.agentDir, "extensions/sabotage.ts"),
		`import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
export default (pi) => { pi.on("session_start", () => {
  const descriptor = process.argv[process.argv.indexOf("--subagent-launch") + 1];
  if (process.env.FIXTURE_SABOTAGE === "malformed") writeFileSync(descriptor, "{");
  if (process.env.FIXTURE_SABOTAGE === "receipt") mkdirSync(JSON.parse(readFileSync(descriptor, "utf8")).receiptPath);
  if (process.env.FIXTURE_SABOTAGE === "tools") pi.setActiveTools(["bash"]);
}); }`,
	);
	for (const mode of ["malformed", "receipt"] as const) {
		fixture.env.FIXTURE_SABOTAGE = mode;
		const attempt = await newRun(fixture);
		assert.notEqual(attempt.result.exitCode, 0, `${mode}: ${JSON.stringify(attempt.result)}`);
		assert.equal(attempt.result.conversationId, attempt.paths.id);
		assert.equal((await fixture.providerCalls()).length, 0, mode);
	}
	delete fixture.env.FIXTURE_SABOTAGE;
	const unavailable = await allocateSession(fixture.root, "reviewer");
	const lease = await acquireLease(unavailable);
	try {
		await prepareTranscript(lease);
		await mkdir(unavailable.config);
		const refused = await runChild({ lease, intent: fixture.newIntent, task: "first-task" }, fixture.runtime);
		assert.notEqual(refused.exitCode, 0);
		assert.equal((await fixture.providerCalls()).length, 0);
	} finally {
		await lease.release();
	}
	const first = await newRun(fixture);
	assert.equal(first.result.exitCode, 0, first.result.stderr);
	fixture.env.FIXTURE_SABOTAGE = "tools";
	const rejected = await resumed(fixture, first.paths);
	assert.notEqual(rejected.exitCode, 0);
	assert.match(rejected.stderr, /mismatch/i);
	assert.equal((await fixture.providerCalls()).length, 1);
});

// The snapshot records actual alias resolution, clamping, and even an empty tool selection.
test("effective model, thinking, tools and prompt are frozen; unavailable selections fail before calls", async (t) => {
	const fixture = await createPiFixture(t);
	const alias = await newRun(fixture, {
		...fixture.newIntent,
		requestedModel: "fixture/revi:max",
		requestedThinking: "max",
	});
	assert.equal(alias.result.exitCode, 0, alias.result.stderr);
	const resolved = await readSavedConfig(alias.paths);
	assert.equal(resolved.provider, "fixture");
	assert.equal(resolved.model, "reviewer");
	assert.equal(resolved.thinkingLevel, "high");
	assert.deepEqual(resolved.tools, ["read", "grep"]);
	const empty = await newRun(fixture, { ...fixture.newIntent, requestedTools: [] });
	assert.equal(empty.result.exitCode, 0, empty.result.stderr);
	assert.deepEqual((await readSavedConfig(empty.paths)).tools, []);
	await fixture.changeDefaultsAndRemoveDefinition();
	const followUp = await resumed(fixture, empty.paths);
	assert.equal(followUp.exitCode, 0, followUp.stderr);
	assert.deepEqual((await fixture.providerCalls())[2].tools, []);
	assert.match((await fixture.providerCalls())[2].systemPrompt, /Fixture reviewer prompt/);
	const missingTool = await newRun(fixture, { ...fixture.newIntent, requestedTools: ["missing-tool"] });
	assert.notEqual(missingTool.result.exitCode, 0);
	await assert.rejects(readSavedConfig(missingTool.paths));
	assert.equal((await fixture.providerCalls()).length, 3);
	const original = await readFile(alias.paths.config, "utf8");
	for (const change of [{ tools: ["missing-tool"] }, { thinkingLevel: "max" }]) {
		await writeFile(alias.paths.config, JSON.stringify({ ...JSON.parse(original), ...change }));
		const rejection = await resumed(fixture, alias.paths);
		assert.notEqual(rejection.exitCode, 0, rejection.stderr);
		assert.equal((await fixture.providerCalls()).length, 3);
	}
	await writeFile(alias.paths.config, original);
});

// JSONL splits only on LF and waits for a real settled assistant message.
test("fragmented UTF-8, CRLF, final record, and malformed events do not invent success", async (t) => {
	const fixture = await createPiFixture(t);
	const { paths, result } = await newRun(fixture);
	assert.equal(result.exitCode, 0, result.stderr);
	const probe = resolve(import.meta.dirname, "fixtures/process-probe.mjs");
	const runtime = (mode: string) => ({
		...fixture.runtime,
		invocation: { command: process.execPath, prefixArgs: [probe, mode] },
	});
	const framed = await resumed(fixture, paths, runtime("fragmented"));
	assert.equal(framed.exitCode, 0, framed.stderr);
	assert.equal(getFinalOutput(framed.messages), "🥳\u2028line");
	assert.equal(framed.usage.turns, 1);
	const fakeReady = await resumed(fixture, paths, runtime("receipt-not-boolean"));
	assert.notEqual(fakeReady.exitCode, 0);
	assert.match(fakeReady.stderr, /receipt/i);
	const noResponse = await resumed(fixture, paths, runtime("exit-before-response"));
	assert.notEqual(noResponse.exitCode, 0);
	assert.match(noResponse.stderr, /completed assistant|settle/i);
	const malformed = await resumed(fixture, paths, runtime("malformed"));
	assert.notEqual(malformed.exitCode, 0);
	assert.match(malformed.stderr, /Malformed child JSON record/i);
	assert.equal((await fixture.providerCalls()).length, 1);
});

// A negative or malformed receipt cannot be rescued by a completed assistant and settlement.
test("negative startup receipts fail closed with nonempty diagnostics", async (t) => {
	const fixture = await createPiFixture(t);
	const { paths, result } = await newRun(fixture);
	assert.equal(result.exitCode, 0, result.stderr);
	const probe = resolve(import.meta.dirname, "fixtures/process-probe.mjs");
	for (const mode of ["receipt-rejected-empty", "receipt-rejected-invalid"]) {
		const failed = await resumed(fixture, paths, {
			...fixture.runtime,
			invocation: { command: process.execPath, prefixArgs: [probe, mode] },
		});
		assert.equal(failed.usage.turns, 1, mode);
		assert.notEqual(failed.exitCode, 0, mode);
		assert.match(failed.errorMessage ?? "", /receipt|startup/i, mode);
		assert.ok(failed.stderr, mode);
		assert.equal(failed.conversationId, paths.id);
	}
	assert.equal((await fixture.providerCalls()).length, 1);
});

// A thrown progress handler cannot abandon a child that is still writing history.
test("throwing progress callback stops the spawned child before returning", async (t) => {
	const fixture = await createPiFixture(t);
	const { paths, result } = await newRun(fixture);
	assert.equal(result.exitCode, 0, result.stderr);
	const saved = await readSavedConfig(paths);
	const lease = await acquireLease(paths);
	try {
		let updates = 0;
		const failed = await runChild(
			{ lease, intent: { kind: "resume", saved }, task: "follow-up-task" },
			fixture.runtime,
			undefined,
			() => {
				if (++updates > 1) throw new Error("update boom");
			},
		);
		assert.notEqual(failed.exitCode, 0);
		assert.match(failed.stderr, /update boom/);
		assert.equal(failed.conversationId, paths.id);
	} finally {
		await lease.release();
	}
});
