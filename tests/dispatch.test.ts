import assert from "node:assert/strict";
import { test } from "node:test";
import { executeSubagent, validateCall } from "../dispatch.ts";
import { getFinalOutput, truncateParallelOutput, type SubagentDetails } from "../results.ts";
import type { Message } from "@earendil-works/pi-ai";
import registerSubagent from "../index.ts";
import {
	initTheme,
	type Theme,
	type ExtensionAPI,
	type ToolDefinition,
	type ToolResultEvent,
	type ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { SubagentParamsSchema } from "../dispatch.ts";
import { createPiFixture } from "./helpers/pi-fixture.ts";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { readSavedConfig, sessionPaths } from "../session-store.ts";
import type { SingleResult } from "../results.ts";

test("a task has one selector and parallel IDs must be unique", () => {
	assert.equal(validateCall({ resume: "reviewer-a1b2c3d4", task: "follow-up" }).tasks[0]?.kind, "resume");
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

// Removing optional-ID fallbacks or status labels breaks old and new TUI results.
test("registered renderers show IDs in both views and tolerate old details at narrow width", () => {
	const recorded: {
		tool?: ToolDefinition<typeof SubagentParamsSchema, SubagentDetails>;
		hook?: (event: ToolResultEvent) => ToolResultEventResult | void;
	} = {};
	registerSubagent({
		registerTool: (tool: ToolDefinition<typeof SubagentParamsSchema, SubagentDetails>) => {
			recorded.tool = tool;
		},
		on: (_name: string, handler: (event: ToolResultEvent) => ToolResultEventResult | void) => {
			recorded.hook = handler;
		},
	} as unknown as ExtensionAPI);
	const tool = recorded.tool!;
	initTheme("dark");
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
	const legacy = {
		agent: "reviewer",
		agentSource: "user" as const,
		task: "Unicode 🙂",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 5, turns: 1 },
	};
	const item = {
		...legacy,
		messages: [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "fixture.txt" } }],
				api: "fixture-api",
				provider: "fixture",
				model: "reviewer",
				stopReason: "toolUse",
				timestamp: 1,
				usage: {
					input: 3,
					output: 2,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 5,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			} as Message,
		],
		conversationId: "reviewer-a1b2c3d4",
		resumed: true,
	};
	const context = {} as Parameters<NonNullable<typeof tool.renderResult>>[3];
	for (const expanded of [false, true]) {
		const result = {
			content: [{ type: "text" as const, text: "done" }],
			details: {
				mode: "parallel" as const,
				agentScope: "user" as const,
				projectAgentsDir: null,
				results: [item, legacy],
			},
		};
		const view = tool.renderResult!(result, { expanded, isPartial: false }, theme, context).render(18).join("\n");
		assert.match(view, /reviewer-a1b2c3d4/);
		assert.match(view, /resumed/);
		assert.match(view, /reviewer/);
		assert.match(view, /read/);
	}
	assert.deepEqual(recorded.hook!({ toolName: "subagent", details: { failed: true } } as ToolResultEvent), {
		isError: true,
	});
	assert.equal(recorded.hook!({ toolName: "other", details: { failed: true } } as ToolResultEvent), undefined);
	assert.equal(recorded.hook!({ toolName: "subagent", details: { results: [] } } as ToolResultEvent), undefined);
	const huge = {
		...item,
		messages: [
			{
				...item.messages[0],
				content: [
					{
						type: "toolCall",
						id: "write-1",
						name: "write",
						arguments: { path: "/tmp/large", content: "x".repeat(100000) },
					},
					{ type: "toolCall", id: "bash-1", name: "bash", arguments: { command: "echo " + "z".repeat(100000) } },
				],
			},
		],
	} as unknown as SingleResult;
	const bounded = tool.renderResult!(
		{ content: [], details: { mode: "single", agentScope: "user", projectAgentsDir: null, results: [huge] } },
		{ expanded: false, isPartial: false },
		theme,
		context,
	)
		.render(18)
		.join("\n");
	assert.ok(bounded.length < 1000, bounded.length.toString());
	assert.match(bounded, /write.*large/);
	assert.match(bounded, /\$ echo/);
	assert.match(bounded, /Ctrl\+O to expand/);
	const chain = tool.renderResult!(
		{
			content: [],
			details: {
				mode: "chain",
				agentScope: "user",
				projectAgentsDir: null,
				results: [
					{ ...item, step: 1 },
					{ ...legacy, step: 2 },
				],
			},
		},
		{ expanded: false, isPartial: false },
		theme,
		context,
	)
		.render(80)
		.join("\n");
	assert.match(chain, /Step 1/);
	assert.match(chain, /Total:.*↑6/);
	assert.match(chain, /user/);
	const running = { ...item, running: true, exitCode: 1, resumable: undefined, usage: { ...item.usage, turns: 1 } };
	for (const expanded of [false, true]) {
		const view = tool.renderResult!(
			{
				content: [],
				details: { mode: "parallel", agentScope: "user", projectAgentsDir: null, results: [legacy, running] },
			},
			{ expanded, isPartial: true },
			theme,
			context,
		)
			.render(40)
			.join("\n");
		assert.match(view, /reviewer-a1b2c3d4/);
		assert.match(view, /… reviewer/);
		assert.doesNotMatch(view, /✗ reviewer \[reviewer-a1b2c3d4\]|not resumable/);
		assert.match(view, /Total:/);
	}
});

test("chain substitution uses all text blocks of the final assistant turn", () => {
	const message = {
		role: "assistant",
		content: [
			{ type: "text", text: "first " },
			{ type: "thinking", thinking: "private" },
			{ type: "text", text: "last" },
		],
	} as Message;
	assert.equal(getFinalOutput([message]), "first last");
});

test("capped Unicode output retains valid codepoints", () => {
	const output = truncateParallelOutput("x" + "🙂".repeat(30000));
	assert.ok(Buffer.byteLength(output.split("\n\n[Output truncated")[0]!) <= 50 * 1024);
	assert.doesNotMatch(output, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u);
});

test("invalid fields are rejected without repair", () => {
	for (const params of [
		{},
		{ agent: " ", task: "x" },
		{ resume: " reviewer-a1b2c3d4", task: "x" },
		{ resume: "../invalid", task: "x" },
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
		{ agent: "reviewer", task: " " },
		{ agent: "reviewer", resume: "", task: "x" },
		{ agent: " reviewer", task: "x" },
		{ agent: "reviewer ", task: "x" },
		{ agent: "reviewer", task: "x", tasks: [] },
		{ chain: [] },
		{ tasks: [{ agent: "reviewer", task: "x" }], cwd: "/tmp" },
		{ chain: [{ agent: "reviewer", task: "x" }], task: "x" },
		{ tasks: Array.from({ length: 9 }, () => ({ agent: "reviewer", task: "x" })) },
	])
		assert.throws(() => validateCall(params));
	assert.deepEqual(validateCall({ agent: "reviewer", task: "  keep  " }), {
		mode: "single",
		tasks: [{ kind: "new", agent: "reviewer", task: "  keep  " }],
		agentScope: "user",
		confirmProjectAgents: true,
	});
});

// Removing native controller restart and tool_result handling breaks this test.
test("two independent controllers resume the same child through the real tool", async (t) => {
	const fixture = await createPiFixture(t);
	await mkdir(join(fixture.agentDir, "agents"));
	await writeFile(
		join(fixture.agentDir, "agents/reviewer.md"),
		"---\nname: reviewer\ndescription: fixture reviewer\nmodel: fixture/reviewer:high\ntools: read, grep\n---\nFixture reviewer prompt.\n",
	);
	const first = await fixture.controller({ agent: "reviewer", task: "first-task" });
	assert.equal(first.exit, 0, first.stderr);
	assert.equal(first.tool?.isError, false, JSON.stringify(first.events));
	assert.match(JSON.stringify(first.tool), /first-answer/);
	const id = first.tool?.details?.results?.[0]?.conversationId as string;
	assert.match(id, /^reviewer-[0-9a-f]{8}$/);
	const initial = await readSavedConfig(sessionPaths(fixture.root, id));
	assert.notEqual(initial.piSessionId, id);
	assert.equal(initial.cwd, fixture.cwd);
	assert.equal(initial.thinkingLevel, "high");
	assert.deepEqual(initial.tools, ["read", "grep"]);
	await fixture.changeDefaultsAndRemoveDefinition();
	await rm(join(fixture.agentDir, "agents/reviewer.md"));
	const second = await fixture.controller({ resume: id, task: "follow-up-task" });
	assert.equal(second.exit, 0, second.stderr);
	assert.equal(second.tool?.isError, false, JSON.stringify(second.tool));
	assert.equal(second.tool?.details?.results?.[0]?.conversationId, id);
	assert.equal(second.tool?.details?.results?.[0]?.usage?.turns, 1);
	assert.match(JSON.stringify(second.tool), /follow-up-answer/);
	assert.doesNotMatch(JSON.stringify(second.tool), /first-answer/);
	const calls = (await fixture.providerCalls()).filter((call) => call.model === "fixture/reviewer");
	assert.equal(calls.length, 2);
	assert.match(JSON.stringify(calls[1].messages), /first-task/);
	assert.match(JSON.stringify(calls[1].messages), /first-answer/);
	assert.equal(calls[1].model, "fixture/reviewer");
	assert.deepEqual(calls[1].tools, ["read", "grep"]);
	assert.match(calls[1].systemPrompt, /Fixture reviewer prompt/);
	const persisted = await readSavedConfig(sessionPaths(fixture.root, id));
	assert.equal(persisted.piSessionId, initial.piSessionId);
	assert.deepEqual(persisted, initial);
});

// A same-named definition and changed scope cannot replace saved project provenance.
test("resume uses saved project identity after definition deletion and scope change", async (t) => {
	const fixture = await createPiFixture(t);
	await mkdir(join(fixture.cwd, ".pi/agents"), { recursive: true });
	await mkdir(join(fixture.agentDir, "agents"));
	await writeFile(
		join(fixture.cwd, ".pi/agents/reviewer.md"),
		"---\nname: reviewer\ndescription: project\nmodel: fixture/reviewer:high\ntools: read\n---\nProject prompt.\n",
	);
	await writeFile(
		join(fixture.agentDir, "agents/reviewer.md"),
		"---\nname: reviewer\ndescription: user\nmodel: fixture/other:low\n---\nWrong prompt.\n",
	);
	const first = await fixture.controller({ agent: "reviewer", task: "project-first", agentScope: "project" });
	assert.equal(first.tool?.isError, false, JSON.stringify(first.tool));
	const id = first.tool?.details?.results?.[0]?.conversationId as string;
	const saved = await readSavedConfig(sessionPaths(fixture.root, id));
	assert.equal(saved.source, "project");
	assert.equal(saved.discoveryCwd, fixture.cwd);
	assert.equal(saved.projectAgentsDir, join(fixture.cwd, ".pi/agents"));
	await rm(join(fixture.cwd, ".pi/agents/reviewer.md"));
	const second = await fixture.controller({ resume: id, task: "project-next", agentScope: "user" });
	assert.equal(second.tool?.isError, false, JSON.stringify(second.tool));
	assert.equal(second.tool?.details?.results?.[0]?.agentSource, "project");
	const calls = (await fixture.providerCalls()).filter((call) => call.model === "fixture/reviewer");
	assert.equal(calls.length, 2);
	assert.match(calls[1].systemPrompt, /Project prompt/);
	assert.doesNotMatch(calls[1].systemPrompt, /Wrong prompt/);
	assert.deepEqual(calls[1].tools, ["read"]);
});

// Returning isError from execute without the hook loses the error bit in Pi's tool transcript.
test("mixed parallel outputs retain IDs and chain failure marks the real tool result", async (t) => {
	const fixture = await createPiFixture(t);
	await mkdir(join(fixture.agentDir, "agents"));
	await writeFile(
		join(fixture.agentDir, "agents/reviewer.md"),
		"---\nname: reviewer\ndescription: fixture reviewer\nmodel: fixture/reviewer:high\ntools: read, grep\n---\nFixture reviewer prompt.\n",
	);
	const start = await fixture.controller({ agent: "reviewer", task: "initial" });
	const id = start.tool?.details?.results?.[0]?.conversationId as string;
	assert.match(id, /^reviewer-[0-9a-f]{8}$/);
	const mixed = await fixture.controller({
		tasks: [
			{ resume: id, task: "follow-up" },
			{ resume: "reviewer-00000000", task: "unknown" },
			{ agent: "reviewer", task: "other" },
		],
	});
	assert.equal(mixed.tool?.isError, false, JSON.stringify(mixed.tool));
	const results = mixed.tool?.details?.results;
	assert.equal(results?.length, 3);
	assert.equal(results[0].conversationId, id);
	assert.match(results[1].errorMessage, /reviewer-00000000/);
	assert.notEqual(results[2].conversationId, id);
	assert.match(mixed.tool?.content?.[0]?.text, /reviewer-00000000/);
	assert.match(mixed.tool?.content?.[0]?.text, /follow-up-answer/);
	const chain = await fixture.controller({
		chain: [
			{ resume: id, task: "chain-one" },
			{ resume: id, task: "chain-two {previous}" },
			{ resume: "reviewer-00000000", task: "chain-three" },
			{ agent: "reviewer", task: "must-not-start" },
		],
	});
	assert.equal(chain.tool?.isError, true, JSON.stringify(chain.tool));
	assert.equal(chain.tool?.details?.failed, true);
	assert.equal(chain.tool?.details?.results?.length, 3);
	assert.match(chain.tool?.content?.[0]?.text, new RegExp(id));
	const calls = (await fixture.providerCalls()).filter((call) => call.model === "fixture/reviewer");
	assert.match(JSON.stringify(calls.at(-1)?.messages), /chain-two follow-up-answer/);
	assert.doesNotMatch(JSON.stringify(calls.at(-1)?.messages), /chain-two .*\[reviewer-/);
	assert.doesNotMatch(JSON.stringify(calls), /must-not-start/);
	const invalid = await fixture.controller({
		tasks: [
			{ resume: id, task: "one" },
			{ resume: id, task: "two" },
		],
	});
	assert.equal(invalid.tool?.isError, true);
	assert.equal(
		(await fixture.providerCalls()).filter((call) => call.model === "fixture/reviewer").length,
		calls.length,
	);
});

// Each scenario runs in a separate process with its agent directory set before launch.
// Its runner aborts and awaits all children and consent waiters before the fixture is removed.
for (const scenario of ["invalid", "consent", "parallel", "allocated", "single-chain"]) {
	test(`isolated orchestration: ${scenario}`, async (t) => {
		const fixture = await createPiFixture(t);
		const result = await fixture.orchestrate(scenario);
		assert.equal(result.exit, 0, `${scenario}: ${result.stderr}\n${result.stdout}`);
		assert.match(result.stdout, /orchestration OK/);
	});
}

test("single worker runtime failure becomes actual Pi tool error with preserved details", async (t) => {
	const fixture = await createPiFixture(t);
	await mkdir(join(fixture.agentDir, "agents"));
	await writeFile(
		join(fixture.agentDir, "agents/reviewer.md"),
		"---\nname: reviewer\ndescription: fixture\nmodel: fixture/reviewer:high\n---\nPrompt.\n",
	);
	const response = await fixture.controller({ agent: "reviewer", task: "fail: runtime failure" });
	assert.equal(response.tool?.isError, true, JSON.stringify(response.tool));
	assert.equal(response.tool?.details?.failed, true);
	assert.match(response.tool?.details?.results[0]?.errorMessage, /fixture runtime failure/);
	assert.match(response.tool?.details?.results[0]?.conversationId, /^reviewer-[0-9a-f]{8}$/);
});
