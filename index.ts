import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { homedir } from "node:os";
import { SubagentParamsSchema, executeSubagent } from "./dispatch.ts";
import { getFinalOutput, getResultOutput, isFailedResult, type SingleResult, type SubagentDetails } from "./results.ts";

const idLabel = (r: SingleResult) =>
	r.conversationId
		? ` [${r.conversationId}] (${r.resumed ? "resumed" : "new"}${r.resumable === false ? ", not resumable" : ""})`
		: "";
const status = (r: SingleResult) => (r.running || r.exitCode === -1 ? "…" : isFailedResult(r) ? "✗" : "✓");
const usage = (r: SingleResult) =>
	[
		`${r.usage.turns} turn${r.usage.turns === 1 ? "" : "s"}`,
		`↑${r.usage.input}`,
		`↓${r.usage.output}`,
		r.usage.cacheRead ? `R${r.usage.cacheRead}` : "",
		r.usage.cacheWrite ? `W${r.usage.cacheWrite}` : "",
		r.usage.cost ? `$${r.usage.cost.toFixed(4)}` : "",
		r.usage.contextTokens ? `ctx:${r.usage.contextTokens}` : "",
		r.model ?? "",
	]
		.filter(Boolean)
		.join(" ");
const preview = (value: unknown, max = 60) => {
	const text = String(value ?? "...").replace(/\s+/g, " ");
	return text.length > max ? `${text.slice(0, max)}...` : text;
};
const pathPreview = (value: unknown) => {
	const path = String(value ?? "...");
	return preview(path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path);
};
function toolPreview(name: string, args: Record<string, unknown>): string {
	const path = pathPreview(args.file_path ?? args.path);
	switch (name) {
		case "bash":
			return `$ ${preview(args.command)}`;
		case "read":
			return `read ${path}${args.offset == null && args.limit == null ? "" : `:${args.offset ?? 1}${typeof args.limit === "number" ? `-${Number(args.offset ?? 1) + args.limit - 1}` : ""}`}`;
		case "write":
			return `write ${path}${typeof args.content === "string" && args.content.includes("\n") ? ` (${args.content.split("\n").length} lines)` : ""}`;
		case "edit":
			return `edit ${path}`;
		case "ls":
			return `ls ${path}`;
		case "find":
			return `find ${preview(args.pattern)} in ${path}`;
		case "grep":
			return `grep /${preview(args.pattern)}/ in ${path}`;
		default:
			return `${preview(name)} ${preview(JSON.stringify(args), 50)}`;
	}
}
const toolCalls = (r: SingleResult) =>
	r.messages.flatMap((message) =>
		message.role === "assistant"
			? message.content
					.filter((part) => part.type === "toolCall")
					.map((part) => `→ ${toolPreview(part.name, part.arguments)}`)
			: [],
	);
const aggregateUsage = (entries: SingleResult[]) => {
	const total = { ...entries[0]!.usage };
	for (const r of entries.slice(1))
		for (const key of Object.keys(total) as (keyof typeof total)[]) total[key] += r.usage[key];
	return usage({ ...entries[0]!, usage: total, model: undefined });
};

export default function (pi: ExtensionAPI): void {
	pi.on("tool_result", (event) => {
		if (event.toolName !== "subagent") return;
		const details = event.details;
		if (details && typeof details === "object" && "failed" in details && details.failed === true)
			return { isError: true };
	});
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized agents with isolated, persistent conversations. Use agent for a new conversation or resume with a returned public ID for a follow-up.",
			"Modes: single (agent or resume + task), parallel (tasks array, max eight, four workers), chain (sequential with {previous} placeholder).",
			`Default agent scope is user (from ${join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: both (or project).`,
		].join(" "),
		parameters: SubagentParamsSchema,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return executeSubagent(params, ctx, signal, onUpdate);
		},
		renderCall(args, theme) {
			const tasks = args.chain ?? args.tasks;
			const mode = args.chain ? "chain" : args.tasks ? "parallel" : "single";
			const title = tasks
				? `${mode} (${tasks.length} ${mode === "chain" ? "steps" : "tasks"})`
				: (args.resume ?? args.agent ?? "...");
			const lines = tasks
				?.slice(0, 3)
				.map(
					(task, index) =>
						`${mode === "chain" ? `${index + 1}. ` : ""}${task.resume ?? task.agent ?? "..."} ${task.task.replace(/\{previous\}/g, "").slice(0, 40)}`,
				) ?? [args.task?.slice(0, 60) ?? "..."];
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", title)}${theme.fg("muted", ` [${args.agentScope ?? "user"}]`)}\n  ${lines.join("\n  ")}`,
				0,
				0,
			);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as SubagentDetails | undefined;
			if (!details?.results?.length) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "(no output)", 0, 0);
			}
			const entries = details.results;
			const title =
				details.mode === "single"
					? ""
					: `${details.mode}: ${entries.filter((r) => !r.running && r.exitCode === 0).length}/${entries.length} completed\n`;
			const row = (r: SingleResult) =>
				`${theme.fg(r.running ? "warning" : isFailedResult(r) ? "error" : "success", status(r))} ${theme.fg("accent", r.agent)}${theme.fg("muted", idLabel(r))} (${r.agentSource})${details.mode === "chain" && r.step ? ` Step ${r.step}` : ""}`;
			const footer =
				details.mode === "single" ? "\n(Ctrl+O to expand)" : `\nTotal: ${aggregateUsage(entries)}\n(Ctrl+O to expand)`;
			if (!expanded) {
				const text =
					title +
					entries
						.map((r) => {
							const output = getFinalOutput(r.messages).split("\n").slice(0, 3).join("\n");
							const allCalls = toolCalls(r);
							const limit = details.mode === "single" ? 10 : 5;
							const calls = allCalls.slice(-limit).join("\n");
							const hint =
								allCalls.length > limit ? `\n... ${allCalls.length - limit} earlier calls (Ctrl+O to expand)` : "";
							return `${row(r)}${calls ? `\n${theme.fg("muted", calls)}` : ""}${hint}\n${theme.fg(!r.running && isFailedResult(r) ? "error" : "toolOutput", !r.running && isFailedResult(r) ? getResultOutput(r) : output || (r.running || r.exitCode === -1 ? "(running...)" : "(no output)"))}\n${theme.fg("dim", usage(r))}`;
						})
						.join("\n\n") +
					footer;
				return new Text(text, 0, 0);
			}
			const container = new Container();
			if (title) container.addChild(new Text(title.trim(), 0, 0));
			for (const r of entries) {
				container.addChild(new Text(row(r), 0, 0));
				container.addChild(new Text(theme.fg("muted", `Task: ${r.task}`), 0, 0));
				for (const call of toolCalls(r)) container.addChild(new Text(theme.fg("muted", call), 0, 0));
				if (!r.running && isFailedResult(r))
					container.addChild(new Text(theme.fg("error", `Error: ${getResultOutput(r)}`), 0, 0));
				else {
					const output = getFinalOutput(r.messages);
					if (output) container.addChild(new Markdown(output, 0, 0, getMarkdownTheme()));
					else container.addChild(new Text(r.running ? "(running...)" : "(no output)", 0, 0));
				}
				container.addChild(new Text(theme.fg("dim", usage(r)), 0, 0));
				container.addChild(new Spacer(1));
			}
			if (details.mode !== "single") container.addChild(new Text(`Total: ${aggregateUsage(entries)}`, 0, 0));
			return container;
		},
	});
}
