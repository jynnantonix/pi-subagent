import type { Message } from "@earendil-works/pi-ai";
import type { AgentScope } from "./agents.ts";

const PER_TASK_OUTPUT_CAP = 50 * 1024;
export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}
export interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	conversationId?: string;
	resumed?: boolean;
	resumable?: boolean;
	running?: boolean;
}
export interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
	failed?: boolean;
}
export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			return msg.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("");
		}
	}
	return "";
}
export function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}
export function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}
export function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;
	let truncated = "";
	let bytes = 0;
	for (const character of output) {
		const size = Buffer.byteLength(character, "utf8");
		if (bytes + size > PER_TASK_OUTPUT_CAP) break;
		truncated += character;
		bytes += size;
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - bytes} bytes omitted. Full output preserved in tool details.]`;
}
