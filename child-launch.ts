import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { SingleResult } from "./results.ts";
import {
	readSavedConfig,
	validateTranscript,
	type AgentIdentity,
	type SavedConfig,
	type SessionLease,
	type SessionPaths,
} from "./session-store.ts";

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

export function defaultChildRuntime(): ChildRuntime {
	const current = process.argv[1];
	const isPiCli = current && /(?:^|\/)pi-coding-agent\/dist\/cli\.js$/.test(current);
	const executable = /^(node|bun)(\.exe)?$/i.test(process.execPath.split(/[\\/]/).pop() ?? "");
	return {
		invocation: isPiCli
			? { command: process.execPath, prefixArgs: [current] }
			: executable
				? { command: "pi", prefixArgs: [] }
				: { command: process.execPath, prefixArgs: [] },
		env: { ...process.env },
		bootstrapPath: resolve(import.meta.dirname, "child-bootstrap.ts"),
		killGraceMs: 5000,
	};
}
function startResult(request: ChildRequest): SingleResult {
	const identity = request.intent.kind === "new" ? request.intent.identity : request.intent.saved;
	return {
		agent: identity.name,
		agentSource: identity.source,
		task: request.task,
		step: request.step,
		exitCode: 1,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		conversationId: request.lease.paths.id,
		resumed: request.intent.kind === "resume",
		resumable: false,
	};
}
export async function runChild(
	request: ChildRequest,
	runtime: ChildRuntime,
	signal?: AbortSignal,
	onUpdate?: (result: SingleResult) => void,
): Promise<SingleResult> {
	const result = startResult(request);
	let temp: string | undefined;
	let proc: ChildProcess | undefined;
	let closed = false;
	let closePromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
	let escalation: NodeJS.Timeout | undefined;
	let abort: (() => void) | undefined;
	let diagnostic = "";
	let settled = false;
	let started = false;
	let completedAssistant = false;
	const identity = request.intent.kind === "new" ? request.intent.identity : request.intent.saved;
	const stop = () => {
		if (!proc || closed) return;
		try {
			proc.kill("SIGTERM");
		} catch {
			/* Wait for close regardless. */
		}
		if (!escalation)
			escalation = setTimeout(() => {
				if (!closed) {
					try {
						proc?.kill("SIGKILL");
					} catch {
						/* Wait for close. */
					}
				}
			}, runtime.killGraceMs);
	};
	try {
		if (signal?.aborted) throw new Error("Child invocation aborted before spawn");
		if (request.intent.kind === "resume") {
			const supplied = request.intent.saved;
			const persisted = await readSavedConfig(request.lease.paths);
			if (
				Object.keys(persisted).some(
					(key) =>
						JSON.stringify(persisted[key as keyof SavedConfig]) !== JSON.stringify(supplied[key as keyof SavedConfig]),
				)
			)
				throw new Error("Saved snapshot differs from persisted configuration");
			await validateTranscript(request.lease.paths, persisted);
			result.resumable = true;
		}
		onUpdate?.(result);
		temp = await mkdtemp(join(tmpdir(), "pi-subagent-launch-"));
		const descriptorPath = join(temp, "launch.json");
		const receiptPath = join(temp, "receipt.json");
		const promptPath = join(temp, "prompt.md");
		const descriptor: LaunchDescriptor = {
			version: 1,
			token: request.lease.token,
			paths: request.lease.paths,
			intent: request.intent,
			receiptPath,
		};
		await writeFile(descriptorPath, JSON.stringify(descriptor), { mode: 0o600 });
		await writeFile(promptPath, identity.systemPrompt, { mode: 0o600 });
		const args = [
			...runtime.invocation.prefixArgs,
			"--mode",
			"json",
			"-p",
			"--session",
			request.lease.paths.transcript,
			"--session-dir",
			request.lease.paths.dir,
			"--extension",
			runtime.bootstrapPath,
			"--subagent-launch",
			descriptorPath,
			"--append-system-prompt",
			promptPath,
		];
		if (request.intent.kind === "resume") {
			const saved = request.intent.saved;
			args.push("--model", `${saved.provider}/${saved.model}`, "--thinking", saved.thinkingLevel);
			if (saved.tools.length) args.push("--tools", saved.tools.join(","));
			else args.push("--no-tools");
		} else {
			if (request.intent.requestedModel) args.push("--model", request.intent.requestedModel);
			if (request.intent.requestedThinking) args.push("--thinking", request.intent.requestedThinking);
			if (request.intent.requestedTools) {
				if (request.intent.requestedTools.length) args.push("--tools", request.intent.requestedTools.join(","));
				else args.push("--no-tools");
			}
		}
		args.push(`Task: ${request.task}`);
		if (signal?.aborted) throw new Error("Child invocation aborted before spawn");
		proc = spawn(runtime.invocation.command, args, {
			cwd: identity.cwd,
			env: runtime.env,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const child = proc;
		closePromise = new Promise((resolveClose) => {
			child.once("close", (code, terminationSignal) => {
				closed = true;
				resolveClose({ code, signal: terminationSignal });
			});
		});
		child.on("error", (error) => {
			diagnostic = error.message;
		});
		abort = () => {
			diagnostic ||= "Child invocation aborted";
			stop();
		};
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		const decoder = new StringDecoder("utf8");
		let buffer = "";
		const processLine = (line: string) => {
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (!line.trim()) return;
			let event: { type?: string; message?: Message };
			try {
				event = JSON.parse(line);
			} catch {
				diagnostic ||= `Malformed child JSON record: ${line.slice(0, 200)}`;
				return;
			}
			if (!event || typeof event !== "object") {
				diagnostic ||= "Invalid child JSON event";
				return;
			}
			if (event.type === "agent_start") {
				started = true;
				settled = false;
			}
			if (event.type === "agent_settled" && started) settled = true;
			if (event.type === "message_end" && event.message) {
				const msg = event.message;
				result.messages.push(msg);
				if (msg.role === "assistant") {
					completedAssistant = true;
					result.usage.turns++;
					result.usage.input += msg.usage.input;
					result.usage.output += msg.usage.output;
					result.usage.cacheRead += msg.usage.cacheRead;
					result.usage.cacheWrite += msg.usage.cacheWrite;
					result.usage.cost += msg.usage.cost.total;
					result.usage.contextTokens = msg.usage.totalTokens;
					result.model = `${msg.provider}/${msg.model}`;
					result.stopReason = msg.stopReason;
					result.errorMessage = msg.errorMessage;
				}
				try {
					onUpdate?.(result);
				} catch (error) {
					diagnostic ||= `Update callback failed: ${String(error)}`;
					stop();
				}
			}
		};
		const consume = (chunk: string) => {
			buffer += chunk;
			let end: number;
			while ((end = buffer.indexOf("\n")) >= 0) {
				processLine(buffer.slice(0, end));
				buffer = buffer.slice(end + 1);
			}
		};
		child.stdout?.on("data", (chunk: Buffer) => {
			try {
				consume(decoder.write(chunk));
			} catch (error) {
				diagnostic ||= `Child event error: ${String(error)}`;
				stop();
			}
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			result.stderr += chunk.toString("utf8");
		});
		if (child.pid) await request.lease.recordChild(child.pid);
		// A failed spawn emits `error` and `close`; retain the actual error diagnostic.
		const exit = await closePromise;
		consume(decoder.end());
		if (buffer) processLine(buffer);
		result.exitCode = exit.code ?? 1;
		let receipt: unknown;
		try {
			receipt = JSON.parse(await readFile(receiptPath, "utf8"));
		} catch {
			diagnostic ||= "Missing or malformed startup receipt";
		}
		const fields =
			receipt && typeof receipt === "object" && !Array.isArray(receipt)
				? (receipt as Record<string, unknown>)
				: undefined;
		let saved: SavedConfig | undefined;
		try {
			saved = await readSavedConfig(request.lease.paths);
		} catch {
			/* Snapshot might not exist after failed initialization. */
		}
		const validReceipt =
			fields?.version === 1 &&
			fields.token === request.lease.token &&
			fields.ready === true &&
			typeof fields.piSessionId === "string" &&
			fields.piSessionId.length > 0 &&
			!!saved &&
			fields.piSessionId === saved.piSessionId &&
			(request.intent.kind !== "resume" || fields.piSessionId === request.intent.saved.piSessionId);
		if (!validReceipt) {
			const rejection =
				fields?.ready === false && typeof fields.error === "string" && fields.error.trim()
					? fields.error
					: "Startup receipt or native session identity mismatch";
			diagnostic ||= rejection;
		}
		result.resumable = false;
		if (saved) {
			try {
				await validateTranscript(request.lease.paths, saved);
				result.resumable = true;
			} catch {
				/* Incomplete history cannot be resumed. */
			}
		}
		if (
			!diagnostic &&
			(result.exitCode !== 0 ||
				!completedAssistant ||
				!settled ||
				result.stopReason === "error" ||
				result.stopReason === "aborted")
		)
			diagnostic =
				result.errorMessage ||
				result.stderr ||
				(!completedAssistant
					? "No completed assistant response"
					: !settled
						? "Child did not settle"
						: `Child exited ${result.exitCode}`);
		if (diagnostic) {
			result.exitCode = 1;
			result.errorMessage = diagnostic;
			result.stderr = [result.stderr, diagnostic].filter(Boolean).join("\n");
		} else result.exitCode = 0;
		return result;
	} catch (error) {
		if (proc && !closed) {
			stop();
			await closePromise;
		}
		result.exitCode = 1;
		result.errorMessage = error instanceof Error ? error.message : String(error);
		result.stderr = [result.stderr, result.errorMessage].filter(Boolean).join("\n");
		return result;
	} finally {
		if (escalation) clearTimeout(escalation);
		if (abort) signal?.removeEventListener("abort", abort);
		if (temp) {
			try {
				await rm(temp, { recursive: true, force: true });
			} catch (error) {
				result.exitCode = 1;
				result.errorMessage = `Failed to remove private launch inputs: ${String(error)}`;
				result.stderr = [result.stderr, result.errorMessage].filter(Boolean).join("\n");
			}
		}
	}
}
