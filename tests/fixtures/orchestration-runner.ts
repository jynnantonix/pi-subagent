// Run orchestration with the fixture agent directory set before this process starts.
import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { executeSubagent, type SubagentParams } from "../../dispatch.ts";
import type { ChildRuntime } from "../../child-launch.ts";
import type { SubagentDetails } from "../../results.ts";
import { acquireLease, sessionPaths } from "../../session-store.ts";

const agentDir = process.env.PI_CODING_AGENT_DIR!;
const home = process.env.HOME!;
const cwd = join(home, "work");
const root = join(agentDir, "subagent-sessions");
const packageDir = resolve(import.meta.dirname, "../../node_modules/@earendil-works/pi-coding-agent");
const runtime: ChildRuntime = {
	invocation: { command: process.execPath, prefixArgs: [join(packageDir, "dist/cli.js")] },
	env: { ...process.env },
	bootstrapPath: resolve(import.meta.dirname, "../../child-bootstrap.ts"),
	killGraceMs: 80,
};
const pending: { message: string; resolve: (accepted: boolean) => void }[] = [];
let active = 0;
let peak = 0;
const confirm = (_title: string, message: string, options?: { signal?: AbortSignal }) => {
	active++;
	peak = Math.max(peak, active);
	return new Promise<boolean>((resolve) => {
		let finished = false;
		const finish = (accepted: boolean) => {
			if (finished) return;
			finished = true;
			options?.signal?.removeEventListener("abort", abort);
			active--;
			resolve(accepted);
		};
		const abort = () => finish(false);
		options?.signal?.addEventListener("abort", abort, { once: true });
		pending.push({ message, resolve: finish });
	});
};
const ctx = (dir = cwd, prompt = confirm, trusted = false) =>
	({
		cwd: dir,
		hasUI: true,
		isProjectTrusted: () => trusted,
		ui: { confirm: prompt },
		model: { provider: "fixture", id: "reviewer" },
		thinkingLevel: "high",
	}) as unknown as ExtensionContext;
const tracked: { abort: AbortController; promise: ReturnType<typeof executeSubagent> }[] = [];
function start(params: SubagentParams, context = ctx(), onUpdate?: Parameters<typeof executeSubagent>[3]) {
	const abort = new AbortController();
	const promise = executeSubagent(params, context, abort.signal, onUpdate, runtime);
	tracked.push({ abort, promise });
	return { abort, promise };
}
async function until(check: () => boolean | Promise<boolean>) {
	for (let i = 0; i < 200; i++) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("timed out waiting for fixture event");
}
async function calls(): Promise<any[]> {
	return (await readFile(process.env.FIXTURE_LOG!, "utf8").catch(() => ""))
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}
async function projectDefinitions() {
	await mkdir(join(cwd, ".pi/agents"), { recursive: true });
	for (const name of ["one", "two"])
		await writeFile(
			join(cwd, `.pi/agents/${name}.md`),
			`---\nname: ${name}\ndescription: ${name}\nmodel: fixture/reviewer:high\n---\n${name} prompt.\n`,
		);
}
async function invalid() {
	for (const params of [
		{
			tasks: [
				{ agent: "reviewer", task: "valid" },
				{ resume: "../invalid", task: "invalid" },
			],
		},
		{
			chain: [
				{ agent: "reviewer", task: "valid" },
				{ resume: "../invalid", task: "invalid" },
			],
		},
	]) {
		await assert.rejects(start(params).promise);
		assert.deepEqual(await readdir(root).catch(() => []), []);
		assert.equal((await calls()).length, 0);
	}
}
async function consentScenario() {
	await projectDefinitions();
	const initial = start({
		tasks: [
			{ agent: "one", task: "one" },
			{ agent: "two", task: "two" },
		],
		agentScope: "project",
	});
	await until(() => pending.length === 1);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(pending.length, 1);
	assert.match(pending[0]!.message, /Source:.*\.pi\/agents/);
	pending[0]!.resolve(true);
	await until(() => pending.length === 2);
	pending[1]!.resolve(false);
	const first = await initial.promise;
	assert.equal(peak, 1);
	assert.equal(first.details?.results.length, 2);
	assert.equal(first.details?.results.filter((r) => r.exitCode === 0).length, 1);
	assert.equal(first.details?.results.find((r) => r.exitCode !== 0)?.conversationId, undefined);
	const id = first.details!.results.find((r) => r.exitCode === 0)!.conversationId!;
	const other = join(home, "other-work");
	await mkdir(other);
	const resume = start({ resume: id, task: "again" }, ctx(other, confirm, true));
	await until(() => pending.length === 3);
	assert.match(pending[2]!.message, /Working directory:/);
	resume.abort.abort();
	assert.equal((await resume.promise).details?.failed, true);
	assert.equal(active, 0);
	assert.deepEqual(await readdir(join(root, id)), ["config.json", "session.jsonl"]);
	const noPrompt = await start(
		{ resume: id, task: "no prompt", confirmProjectAgents: false },
		ctx(other, confirm, true),
	).promise;
	assert.equal(noPrompt.details?.failed, false);
	const trusted = await start({ resume: id, task: "trusted" }, ctx(cwd, confirm, true)).promise;
	assert.equal(trusted.details?.failed, false);
	assert.equal(pending.length, 3);
	const before = await readdir(root);
	// A different controller cwd still discovers definitions at its own cwd. The queued
	// task is eligible: copy the definition into that cwd, not just the first controller's.
	await mkdir(join(other, ".pi/agents"), { recursive: true });
	await writeFile(
		join(other, ".pi/agents/two.md"),
		"---\nname: two\ndescription: two\nmodel: fixture/reviewer:high\n---\nTwo prompt.\n",
	);
	const count = (await calls()).length;
	const queued = start(
		{
			tasks: [
				{ resume: id, task: "active dialog" },
				{ agent: "two", task: "queued dialog" },
			],
			agentScope: "project",
		},
		ctx(other, confirm, false),
	);
	await until(() => pending.length === 4);
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.equal(pending.length, 4);
	queued.abort.abort();
	const cancelled = await queued.promise;
	assert.equal(cancelled.details?.failed, true);
	assert.equal(cancelled.details?.results.length, 2);
	assert.ok(
		cancelled.details?.results.every((r) => /abort/i.test(r.errorMessage ?? "")),
		JSON.stringify(cancelled.details),
	);
	assert.equal(pending.length, 4);
	assert.equal((await calls()).length, count);
	assert.deepEqual(await readdir(root), before);
	assert.deepEqual(await readdir(join(root, id)), ["config.json", "session.jsonl"]);
	// A waiter behind another invocation's active dialog must not open after cancellation.
	const blocker = start({ agent: "one", task: "blocker", agentScope: "project" });
	await until(() => pending.length === 5);
	const waiting = start({ resume: id, task: "waiting" }, ctx(other, confirm, true));
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.equal(pending.length, 5);
	const priorCount = (await calls()).length;
	waiting.abort.abort();
	const waited = await waiting.promise;
	assert.match(waited.details?.results[0]?.errorMessage ?? "", /abort/i);
	assert.deepEqual(await readdir(join(root, id)), ["config.json", "session.jsonl"]);
	assert.equal(active, 1);
	pending[4]!.resolve(false);
	await blocker.promise;
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.equal(pending.length, 5);
	assert.equal((await calls()).length, priorCount);
	assert.equal(active, 0);
}
async function parallelScenario() {
	const gate = join(home, "gate");
	runtime.env.FIXTURE_GATE = gate;
	runtime.env.FIXTURE_RELEASE_FIRST = join(home, "release-first");
	const updates: { text: string; details: SubagentDetails }[] = [];
	const tasks = Array.from({ length: 4 }, (_, i) => ({ agent: "reviewer", task: `hold:${i}` }));
	const running = start({ tasks }, ctx(), (update) => {
		if (update.details)
			updates.push({ text: update.content[0]?.type === "text" ? update.content[0].text : "", details: update.details });
	});
	await until(async () => (await calls()).filter((c) => c.model === "fixture/reviewer").length === 4);
	assert.equal((await calls()).filter((c) => c.model === "fixture/reviewer").length, 4);
	await until(() =>
		updates.some((u) => u.details.results.length === 4 && u.details.results.every((r) => r.conversationId)),
	);
	const snapshot = updates.find(
		(u) => u.details.results.length === 4 && u.details.results.every((r) => r.conversationId),
	)!.details;
	assert.deepEqual(
		snapshot.results.map((r) => r.task),
		tasks.slice(0, 4).map((r) => r.task),
	);
	assert.ok(snapshot.results.every((r) => r.running && r.resumable !== false));
	assert.equal(new Set(snapshot.results.map((r) => r.conversationId)).size, 4);
	await writeFile(runtime.env.FIXTURE_RELEASE_FIRST!, "go");
	await until(() => updates.some((u) => u.details.results.some((r) => r.task === "hold:0" && !r.running)));
	const mixed = updates.find((u) => u.details.results.some((r) => r.task === "hold:0" && !r.running))!;
	assert.match(mixed.text, /Parallel: 1\/4 done/);
	assert.deepEqual(
		mixed.details.results.map((r) => r.task),
		tasks.slice(0, 4).map((r) => r.task),
	);
	assert.ok(mixed.details.results.slice(1).every((r) => r.running));
	// Message and usage snapshots are ordered even while the other children remain live.
	assert.equal(mixed.details.results[0]?.usage.turns, 1);
	assert.match(JSON.stringify(mixed.details.results[0]?.messages), /first-answer/);
	assert.equal(mixed.details.results[1]?.usage.turns, 0);
	running.abort.abort();
	const result = await running.promise;
	assert.equal(result.details?.failed, false); // The first child completed successfully.
	assert.equal(result.details?.results.length, 4);
	assert.equal((await calls()).filter((c) => c.model === "fixture/reviewer").length, 4);
	const queueTasks = Array.from({ length: 8 }, (_, i) => ({ agent: "reviewer", task: `hold:${i + 1}` }));
	const queued = start({ tasks: queueTasks });
	await until(async () => (await calls()).filter((c) => c.model === "fixture/reviewer").length === 8);
	queued.abort.abort();
	const stopped = await queued.promise;
	assert.equal(stopped.details?.results.length, 4);
	assert.equal(stopped.details?.failed, true);
	assert.equal((await calls()).filter((c) => c.model === "fixture/reviewer").length, 8);
	const pre = new AbortController();
	pre.abort();
	const empty = await executeSubagent({ tasks: queueTasks }, ctx(), pre.signal, undefined, runtime);
	assert.equal(empty.details?.failed, true);
	assert.deepEqual(empty.details?.results, []);
}
async function allocatedScenario() {
	const invocation = start({ agent: "reviewer", task: "never started" }, ctx(), (update) => {
		if (update.details?.results[0]?.conversationId) invocation.abort.abort();
	});
	const response = await invocation.promise;
	const result = response.details!.results[0]!;
	assert.match(result.conversationId!, /^reviewer-[0-9a-f]{8}$/);
	assert.equal(result.resumable, false);
	assert.match(response.content[0]?.type === "text" ? response.content[0].text : "", /not resumable/);
	assert.deepEqual(await readdir(join(root, result.conversationId!)), ["session.jsonl"]);
	assert.equal((await calls()).length, 0);
}
async function singleChainScenario() {
	const updates: SubagentDetails[] = [];
	const first = await start({ agent: "reviewer", task: "first" }, ctx(), (u) => {
		if (u.details) updates.push(u.details);
	}).promise;
	const id = first.details!.results[0]!.conversationId!;
	const live = updates.find((u) => u.results[0]?.running && u.results[0].usage.turns === 1)!.results[0]!;
	assert.equal(live.conversationId, id);
	assert.equal(live.usage.input, 3);
	assert.equal(live.usage.turns, 1);
	assert.equal(live.resumable, undefined);
	const chainUpdates: SubagentDetails[] = [];
	const chain = await start(
		{
			chain: [
				{ resume: id, task: "step one" },
				{ resume: id, task: "step two {previous}" },
			],
		},
		ctx(),
		(u) => {
			if (u.details) chainUpdates.push(u.details);
		},
	).promise;
	assert.equal(chain.details?.failed, false);
	assert.deepEqual(
		chain.details?.results.map((r) => [r.step, r.conversationId, r.usage.turns]),
		[
			[1, id, 1],
			[2, id, 1],
		],
	);
	assert.ok(
		chainUpdates.some(
			(u) =>
				u.results.length === 2 &&
				u.results[0]?.step === 1 &&
				u.results[1]?.running &&
				u.results[1]?.conversationId === id,
		),
	);
	const lease = await acquireLease(sessionPaths(root, id));
	try {
		const busy = await start({ resume: id, task: "busy" }).promise;
		assert.equal(busy.details?.failed, true);
		assert.equal(busy.details?.results[0]?.resumable, undefined);
		assert.match(busy.content[0]?.type === "text" ? busy.content[0].text : "", /conversation busy/);
		assert.doesNotMatch(busy.content[0]?.type === "text" ? busy.content[0].text : "", /not resumable/);
	} finally {
		await lease.release();
	}
	await appendFile(sessionPaths(root, id).transcript, "not valid json\n");
	const corrupt = await start({ resume: id, task: "corrupt" }).promise;
	assert.equal(corrupt.details?.results[0]?.resumable, false);
	assert.match(corrupt.content[0]?.type === "text" ? corrupt.content[0].text : "", /not resumable/);
}
async function main() {
	await mkdir(join(agentDir, "agents"), { recursive: true });
	await writeFile(
		join(agentDir, "agents/reviewer.md"),
		"---\nname: reviewer\ndescription: fixture\nmodel: fixture/reviewer:high\n---\nReviewer prompt.\n",
	);
	switch (process.argv[2]) {
		case "invalid":
			await invalid();
			break;
		case "consent":
			await consentScenario();
			break;
		case "parallel":
			await parallelScenario();
			break;
		case "allocated":
			await allocatedScenario();
			break;
		case "single-chain":
			await singleChainScenario();
			break;
		default:
			throw new Error(`Unknown orchestration scenario: ${process.argv[2]}`);
	}
}
try {
	await main();
	console.log("orchestration OK");
} finally {
	// Settle every invocation before the parent fixture may remove its storage.
	for (const entry of tracked) entry.abort.abort();
	for (const dialog of pending) dialog.resolve(false);
	await Promise.allSettled(tracked.map((entry) => entry.promise));
}
