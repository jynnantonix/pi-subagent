import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { discoverAgents, type AgentConfig, type AgentScope } from "./agents.ts";
import { defaultChildRuntime, runChild, type ChildRuntime, type LaunchIntent } from "./child-launch.ts";
import {
	getFinalOutput,
	getResultOutput,
	isFailedResult,
	truncateParallelOutput,
	type SingleResult,
	type SubagentDetails,
} from "./results.ts";
import {
	acquireLease,
	isPublicSessionId,
	allocateSession,
	prepareTranscript,
	readSavedConfig,
	sessionPaths,
	validateTranscript,
	type AgentIdentity,
} from "./session-store.ts";

const TaskItem = Type.Object({
	agent: Type.Optional(Type.String({ description: "Agent name for a new conversation" })),
	resume: Type.Optional(Type.String({ description: "Public conversation ID for an existing conversation" })),
	task: Type.String({ description: "Task to delegate (chain tasks may use {previous})" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for a new conversation" })),
});
export const SubagentParamsSchema = Type.Object({
	agent: Type.Optional(Type.String({ description: "Agent name for a new single conversation" })),
	resume: Type.Optional(Type.String({ description: "Public ID to resume a single conversation" })),
	task: Type.Optional(Type.String({ description: "Task for single mode" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for a new single conversation" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Up to eight parallel new or resumed tasks" })),
	chain: Type.Optional(
		Type.Array(TaskItem, {
			description: "Sequential new or resumed tasks; {previous} inserts the last assistant text",
		}),
	),
	agentScope: Type.Optional(
		StringEnum(["user", "project", "both"] as const, {
			description: "Scope for discovering new agents. Default: user.",
			default: "user",
		}),
	),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt for project-local agent definitions. Default: true.", default: true }),
	),
});
export type SubagentParams = Static<typeof SubagentParamsSchema>;
export type SelectedTask =
	| { kind: "new"; agent: string; task: string; cwd?: string }
	| { kind: "resume"; id: string; task: string };
export interface ValidatedCall {
	mode: "single" | "parallel" | "chain";
	tasks: SelectedTask[];
	agentScope: AgentScope;
	confirmProjectAgents: boolean;
}
function present(obj: object, key: string): boolean {
	return Object.hasOwn(obj, key);
}
function nonblank(value: unknown): value is string {
	return typeof value === "string" && !!value.trim();
}
function select(item: { agent?: string; resume?: string; task?: string; cwd?: string }): SelectedTask {
	if (present(item, "agent") === present(item, "resume") || !nonblank(item.task))
		throw new Error("Each task requires exactly one selector and a nonblank task");
	if (present(item, "resume")) {
		if (!nonblank(item.resume) || !isPublicSessionId(item.resume) || present(item, "cwd"))
			throw new Error("Invalid resume selector or cwd");
		return { kind: "resume", id: item.resume, task: item.task };
	}
	if (!nonblank(item.agent) || item.agent !== item.agent.trim() || (present(item, "cwd") && !nonblank(item.cwd)))
		throw new Error("Invalid agent or cwd");
	return { kind: "new", agent: item.agent, task: item.task, ...(present(item, "cwd") ? { cwd: item.cwd } : {}) };
}
export function validateCall(params: SubagentParams): ValidatedCall {
	const batch = present(params, "tasks");
	const chain = present(params, "chain");
	const single = ["agent", "resume", "task"].some((key) => present(params, key));
	if (Number(batch) + Number(chain) + Number(single) !== 1 || ((batch || chain) && present(params, "cwd")))
		throw new Error("Provide exactly one mode; cwd applies only to single mode");
	if (params.agentScope !== undefined && !["user", "project", "both"].includes(params.agentScope))
		throw new Error("Invalid agentScope");
	if (params.confirmProjectAgents !== undefined && typeof params.confirmProjectAgents !== "boolean")
		throw new Error("Invalid confirmation option");
	const mode = batch ? "parallel" : chain ? "chain" : "single";
	const items = batch ? params.tasks : chain ? params.chain : [params];
	if (!Array.isArray(items) || !items.length || (batch && items.length > 8))
		throw new Error("Invalid task count (maximum eight parallel tasks)");
	const tasks = items.map(select);
	if (batch) {
		const ids = tasks
			.filter((task): task is Extract<SelectedTask, { kind: "resume" }> => task.kind === "resume")
			.map((task) => task.id);
		if (ids.length !== new Set(ids).size) throw new Error("Duplicate parallel resume ID");
	}
	return {
		mode,
		tasks,
		agentScope: params.agentScope ?? "user",
		confirmProjectAgents: params.confirmProjectAgents ?? true,
	};
}
const usage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 });
function failure(task: SelectedTask, text: string, step?: number, id?: string, resumable?: boolean): SingleResult {
	return {
		agent: task.kind === "new" ? task.agent : (id ?? task.id),
		agentSource: "unknown",
		task: task.task,
		step,
		exitCode: 1,
		messages: [],
		stderr: text,
		errorMessage: text,
		usage: usage(),
		conversationId: id ?? (task.kind === "resume" ? task.id : undefined),
		resumed: task.kind === "resume",
		resumable,
	};
}
function heading(r: SingleResult): string {
	return `${r.agent}${r.conversationId ? ` [${r.conversationId}] (${r.resumed ? "resumed" : "new"}${r.resumable === false ? ", not resumable" : ""})` : ""}`;
}
function details(
	call: ValidatedCall,
	projectAgentsDir: string | null,
	results: SingleResult[],
	failed = false,
): SubagentDetails {
	return { mode: call.mode, agentScope: call.agentScope, projectAgentsDir, results, failed };
}
// Pi has one selector. Cancelled waiters leave immediately without opening a dialog.
let dialogTail: Promise<void> = Promise.resolve();
async function serialDialog(signal: AbortSignal | undefined, show: () => Promise<boolean>): Promise<boolean> {
	const prior = dialogTail;
	let release!: () => void;
	dialogTail = new Promise<void>((resolve) => {
		release = resolve;
	});
	let abort!: () => void;
	const cancelled = new Promise<never>((_, reject) => {
		abort = () => reject(new Error("Subagent invocation aborted"));
	});
	signal?.addEventListener("abort", abort, { once: true });
	try {
		if (signal?.aborted) abort();
		await Promise.race([prior, cancelled]);
		if (signal?.aborted) throw new Error("Subagent invocation aborted");
		return await show();
	} finally {
		signal?.removeEventListener("abort", abort);
		// A cancelled waiter cannot release the slot ahead of the active dialog.
		void prior.then(release);
	}
}
async function consent(
	identity: AgentIdentity,
	call: ValidatedCall,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<void> {
	if (identity.source !== "project" || !call.confirmProjectAgents || !ctx.hasUI) return;
	const controllerCwd = await realpath(ctx.cwd);
	if (ctx.isProjectTrusted() && controllerCwd === identity.discoveryCwd && controllerCwd === identity.cwd) return;
	if (
		!(await serialDialog(signal, () =>
			ctx.ui.confirm(
				"Run project-local agent?",
				`Agent: ${identity.name}\nSource: ${identity.definitionPath}\nWorking directory: ${identity.cwd}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
				{ signal },
			),
		))
	) {
		if (signal?.aborted) throw new Error("Subagent invocation aborted");
		throw new Error(`Project agent not approved: ${identity.name}`);
	}
}
async function runSelected(
	task: SelectedTask,
	call: ValidatedCall,
	ctx: ExtensionContext,
	agents: AgentConfig[],
	signal: AbortSignal | undefined,
	step: number | undefined,
	publish: (r: SingleResult) => void,
	runtime: ChildRuntime,
): Promise<SingleResult> {
	let id: string | undefined;
	let resumable: boolean | undefined;
	let identity: AgentIdentity | undefined;
	let paths;
	try {
		if (signal?.aborted) throw new Error("Subagent invocation aborted");
		if (task.kind === "new") {
			const agent = agents.find((a) => a.name === task.agent);
			if (!agent)
				throw new Error(
					`Unknown agent: "${task.agent}". Available agents: ${agents.map((a) => `"${a.name}"`).join(", ") || "none"}.`,
				);
			identity = {
				name: agent.name,
				source: agent.source,
				definitionPath: await realpath(agent.filePath),
				discoveryCwd: await realpath(ctx.cwd),
				projectAgentsDir: agent.source === "project" ? await realpath(join(agent.filePath, "..")) : null,
				cwd: await realpath(task.cwd ?? ctx.cwd),
				systemPrompt: agent.systemPrompt,
			};
			await consent(identity, call, ctx, signal);
			if (signal?.aborted) throw new Error("Subagent invocation aborted");
			paths = await allocateSession(join(getAgentDir(), "subagent-sessions"), agent.name);
			id = paths.id;
		} else {
			paths = sessionPaths(join(getAgentDir(), "subagent-sessions"), task.id);
			id = task.id;
		}
		publish({
			...failure(task, "", step, id, resumable),
			agent: identity?.name ?? (task.kind === "resume" ? task.id : task.agent),
			agentSource: identity?.source ?? "unknown",
			running: true,
			exitCode: -1,
		});
		const lease = await acquireLease(paths);
		let result: SingleResult;
		try {
			let intent: LaunchIntent;
			if (task.kind === "resume") {
				let saved;
				try {
					saved = await readSavedConfig(paths);
					await validateTranscript(paths, saved);
				} catch (error) {
					resumable = false; // A missing snapshot or invalid history cannot be resumed.
					throw error;
				}
				const dir = await stat(saved.cwd);
				if (!dir.isDirectory() || (await realpath(saved.cwd)) !== saved.cwd)
					throw new Error(`Saved working directory unavailable: ${saved.cwd}`);
				resumable = true;
				identity = saved;
				await consent(saved, call, ctx, signal);
				intent = { kind: "resume", saved };
			} else {
				await prepareTranscript(lease);
				const agent = agents.find((a) => a.name === task.agent)!;
				intent = {
					kind: "new",
					identity: identity!,
					requestedModel: agent.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined),
					requestedThinking: agent.model ? undefined : ctx.thinkingLevel,
					requestedTools: agent.tools,
				};
			}
			result = await runChild({ lease, intent, task: task.task, step }, runtime, signal, (live) =>
				publish({ ...live, usage: { ...live.usage }, messages: [...live.messages], running: true }),
			);
		} catch (error) {
			result = failure(
				task,
				error instanceof Error ? error.message : String(error),
				step,
				id,
				task.kind === "new" ? false : resumable,
			);
		} finally {
			try {
				await lease.release();
			} catch (error) {
				const message = `Failed to release conversation lease: ${String(error)}`;
				if (result!) {
					result!.exitCode = 1;
					result!.errorMessage = message;
					result!.stderr = [result!.stderr, message].filter(Boolean).join("\n");
				} else result = failure(task, message, step, id, task.kind === "new" ? false : resumable);
			}
		}
		if (identity) {
			result.agent = identity.name;
			result.agentSource = identity.source;
		}
		return result;
	} catch (error) {
		const result = failure(
			task,
			error instanceof Error ? error.message : String(error),
			step,
			id,
			id && task.kind === "new" ? false : resumable,
		);
		if (identity) {
			result.agent = identity.name;
			result.agentSource = identity.source;
		}
		return result;
	}
}
export async function executeSubagent(
	params: SubagentParams,
	ctx: ExtensionContext,
	signal?: AbortSignal,
	onUpdate?: (partial: AgentToolResult<SubagentDetails>) => void,
	runtime: ChildRuntime = defaultChildRuntime(),
): Promise<AgentToolResult<SubagentDetails>> {
	const call = validateCall(params);
	const discovery = call.tasks.some((task) => task.kind === "new")
		? discoverAgents(ctx.cwd, call.agentScope)
		: { agents: [], projectAgentsDir: null };
	// One invocation owns both cancellation and callback failures. Abort all admitted
	// children, then let every worker finish its lease before returning details.
	const cancellation = new AbortController();
	const abort = () => cancellation.abort();
	signal?.addEventListener("abort", abort, { once: true });
	if (signal?.aborted) abort();
	let progressError: string | undefined;
	const done: SingleResult[] = [];
	const emit = (results: SingleResult[], text: string) => {
		if (progressError) return;
		try {
			onUpdate?.({ content: [{ type: "text", text }], details: details(call, discovery.projectAgentsDir, results) });
		} catch (error) {
			progressError = `Progress update failed: ${String(error)}`;
			abort();
		}
	};
	const run = (task: SelectedTask, step?: number, taskText = task.task) =>
		runSelected(
			{ ...task, task: taskText },
			call,
			ctx,
			discovery.agents,
			cancellation.signal,
			step,
			(result) => {
				emit([...done, result], `Running ${heading(result)}...`);
			},
			runtime,
		);
	try {
		if (call.mode === "parallel") {
			const results: (SingleResult | undefined)[] = Array.from({ length: call.tasks.length });
			let next = 0;
			await Promise.all(
				Array.from({ length: Math.min(4, call.tasks.length) }, async () => {
					while (next < call.tasks.length && !cancellation.signal.aborted) {
						const index = next++;
						results[index] = await runSelected(
							call.tasks[index]!,
							call,
							ctx,
							discovery.agents,
							cancellation.signal,
							undefined,
							(r) => {
								results[index] = r;
								const current = results.filter((entry): entry is SingleResult => !!entry);
								emit(
									current,
									`Parallel: ${current.filter((item) => !item.running).length}/${call.tasks.length} done; ${heading(r)}`,
								);
							},
							runtime,
						);
						emit(
							results.filter((r): r is SingleResult => !!r),
							`Parallel: ${results.filter((entry) => entry && !entry.running).length}/${call.tasks.length} done; ${heading(results[index]!)}`,
						);
					}
				}),
			);
			const executed = results.filter((r): r is SingleResult => !!r);
			const success = executed.filter((r) => !isFailedResult(r)).length;
			return {
				content: [
					{
						type: "text",
						text: `Parallel: ${success}/${executed.length} succeeded${cancellation.signal.aborted ? " (queue aborted)" : ""}${progressError ? `\n${progressError}` : ""}\n\n${executed.map((r) => `### [${heading(r)}] ${isFailedResult(r) ? "failed" : "completed"}\n\n${truncateParallelOutput(getResultOutput(r))}`).join("\n\n---\n\n")}`,
					},
				],
				details: details(call, discovery.projectAgentsDir, executed, !!progressError || success === 0),
			};
		}
		if (call.mode === "chain") {
			let previous = "";
			for (const [i, task] of call.tasks.entries()) {
				if (cancellation.signal.aborted) break;
				const result = await run(task, i + 1, task.task.replace(/\{previous\}/g, previous));
				done.push(result);
				if (isFailedResult(result))
					return {
						content: [
							{
								type: "text",
								text: `Chain stopped at step ${i + 1} (${heading(result)}): ${getResultOutput(result)}${progressError ? `\n${progressError}` : ""}\nExecuted: ${done.map(heading).join(", ")}`,
							},
						],
						details: details(call, discovery.projectAgentsDir, done, true),
					};
				previous = getFinalOutput(result.messages);
			}
			return {
				content: [
					{
						type: "text",
						text: `${done.length ? getResultOutput(done.at(-1)!) : "Chain aborted before first step"}${progressError ? `\n${progressError}` : ""}\nExecuted: ${done.map(heading).join(", ")}`,
					},
				],
				details: details(call, discovery.projectAgentsDir, done, !!progressError || done.length !== call.tasks.length),
			};
		}
		const result = await run(call.tasks[0]!);
		const failed = isFailedResult(result);
		return {
			content: [
				{
					type: "text",
					text: `${heading(result)}: ${getResultOutput(result)}${progressError ? `\n${progressError}` : ""}`,
				},
			],
			details: details(call, discovery.projectAgentsDir, [result], failed || !!progressError),
		};
	} finally {
		signal?.removeEventListener("abort", abort);
	}
}
