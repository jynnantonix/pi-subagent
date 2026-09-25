import { lstat, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	parseSavedConfig,
	publishSavedConfig,
	readSavedConfig,
	sessionPaths,
	type SavedConfig,
} from "./session-store.ts";
import type { LaunchDescriptor, StartupReceipt } from "./child-launch.ts";

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function absolute(value: unknown): value is string {
	return typeof value === "string" && isAbsolute(value) && resolve(value) === value;
}
export async function readLaunchDescriptor(path: string): Promise<LaunchDescriptor> {
	if (!absolute(path) || path !== join(dirname(path), "launch.json"))
		throw new Error("Invalid subagent launch descriptor path");
	const dir = dirname(path);
	const stat = await lstat(dir);
	const file = await lstat(path);
	if (
		!stat.isDirectory() ||
		stat.isSymbolicLink() ||
		stat.mode & 0o077 ||
		!file.isFile() ||
		file.isSymbolicLink() ||
		file.mode & 0o077
	)
		throw new Error("Invalid private launch inputs");
	const value: unknown = JSON.parse(await readFile(path, "utf8"));
	if (
		!record(value) ||
		Object.keys(value).sort().join() !== "intent,paths,receiptPath,token,version" ||
		value.version !== 1 ||
		typeof value.token !== "string" ||
		!value.token ||
		!absolute(value.receiptPath) ||
		value.receiptPath !== join(dir, "receipt.json") ||
		!record(value.paths)
	)
		throw new Error("Invalid subagent launch descriptor");
	const paths = value.paths;
	if (!absolute(paths.root) || typeof paths.id !== "string") throw new Error("Invalid session paths");
	const expected = sessionPaths(paths.root, paths.id);
	if (
		Object.keys(paths).sort().join() !== Object.keys(expected).sort().join() ||
		Object.entries(expected).some(([key, entry]) => paths[key] !== entry)
	)
		throw new Error("Invalid session paths");
	const intent = value.intent;
	if (!record(intent)) throw new Error("Invalid launch intent");
	if (intent.kind === "resume") {
		if (Object.keys(intent).sort().join() !== "kind,saved") throw new Error("Invalid resume intent");
		const saved = parseSavedConfig(intent.saved);
		if (saved.id !== expected.id) throw new Error("Saved conversation ID mismatch");
		return {
			version: 1,
			paths: expected,
			token: value.token,
			receiptPath: value.receiptPath,
			intent: { kind: "resume", saved },
		};
	}
	if (
		intent.kind !== "new" ||
		!record(intent.identity) ||
		Object.keys(intent).some(
			(key) => !["kind", "identity", "requestedModel", "requestedThinking", "requestedTools"].includes(key),
		)
	)
		throw new Error("Invalid new intent");
	const identity = intent.identity;
	if (
		Object.keys(identity).sort().join() !==
			"cwd,definitionPath,discoveryCwd,name,projectAgentsDir,source,systemPrompt" ||
		typeof identity.name !== "string" ||
		!identity.name ||
		!["user", "project"].includes(String(identity.source)) ||
		!absolute(identity.cwd) ||
		!absolute(identity.definitionPath) ||
		!absolute(identity.discoveryCwd) ||
		(identity.source === "user" ? identity.projectAgentsDir !== null : !absolute(identity.projectAgentsDir)) ||
		typeof identity.systemPrompt !== "string" ||
		(intent.requestedModel !== undefined && typeof intent.requestedModel !== "string") ||
		(intent.requestedThinking !== undefined &&
			!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(intent.requestedThinking))) ||
		(intent.requestedTools !== undefined &&
			(!Array.isArray(intent.requestedTools) ||
				!intent.requestedTools.every((tool: unknown) => typeof tool === "string" && !!tool) ||
				new Set(intent.requestedTools).size !== intent.requestedTools.length))
	)
		throw new Error("Invalid new intent");
	return value as unknown as LaunchDescriptor;
}

function sameTools(actual: string[], expected: string[]): boolean {
	return actual.length === expected.length && actual.every((name) => expected.includes(name));
}
export async function captureOrVerifyStartup(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	descriptor: LaunchDescriptor,
): Promise<SavedConfig> {
	const { paths, token, intent } = descriptor;
	const owner = JSON.parse(await readFile(join(paths.lock, "owner.json"), "utf8")) as { token?: string };
	if (owner.token !== token) throw new Error("Lease token mismatch");
	const identity = intent.kind === "new" ? intent.identity : intent.saved;
	if ((await realpath(ctx.cwd)) !== identity.cwd || ctx.sessionManager.getSessionFile() !== paths.transcript)
		throw new Error("Session path or working directory mismatch");
	const header = ctx.sessionManager.getHeader();
	if (!header || header.cwd !== identity.cwd || !header.id) throw new Error("Native session header mismatch");
	if (
		!ctx.model ||
		!ctx.modelRegistry.getAll().some((model) => model.provider === ctx.model?.provider && model.id === ctx.model?.id)
	)
		throw new Error("Selected model is absent from loaded catalog");
	const tools = pi.getActiveTools();
	const available = new Set(pi.getAllTools().map((tool) => tool.name));
	if (tools.some((tool) => !available.has(tool))) throw new Error("Unknown startup tool");
	const config: SavedConfig = {
		...identity,
		version: 1,
		id: paths.id,
		piSessionId: header.id,
		provider: ctx.model.provider,
		model: ctx.model.id,
		thinkingLevel: pi.getThinkingLevel(),
		tools,
	};
	if (intent.kind === "resume") {
		const saved = intent.saved;
		const persisted = await readSavedConfig(paths);
		if (
			Object.keys(persisted).some(
				(key) =>
					JSON.stringify(persisted[key as keyof SavedConfig]) !== JSON.stringify(saved[key as keyof SavedConfig]),
			)
		)
			throw new Error("Saved snapshot differs from persisted configuration");
		if (
			header.id !== saved.piSessionId ||
			config.provider !== saved.provider ||
			config.model !== saved.model ||
			config.thinkingLevel !== saved.thinkingLevel ||
			!sameTools(tools, saved.tools) ||
			saved.tools.some((tool) => !available.has(tool))
		)
			throw new Error("Saved startup configuration mismatch");
	} else {
		if (
			intent.requestedTools &&
			(!sameTools(tools, intent.requestedTools) || intent.requestedTools.some((tool) => !available.has(tool)))
		)
			throw new Error("Requested startup tools unavailable");
		await publishSavedConfig(paths, token, config);
	}
	return config;
}
export async function writeStartupReceipt(path: string, receipt: StartupReceipt): Promise<void> {
	if (!absolute(path) || path !== join(dirname(path), "receipt.json")) throw new Error("Invalid receipt path");
	const temp = join(dirname(path), `.${randomUUID()}.tmp`);
	try {
		const handle = await open(temp, "wx", 0o600);
		try {
			await handle.writeFile(JSON.stringify(receipt));
		} finally {
			await handle.close();
		}
		await rename(temp, path);
	} finally {
		await rm(temp, { force: true });
	}
}
export default function bootstrap(pi: ExtensionAPI): void {
	pi.registerFlag("subagent-launch", { type: "string" });
	pi.on("input", async (_event, ctx) => {
		let descriptor: LaunchDescriptor | undefined;
		try {
			const flag = pi.getFlag("subagent-launch");
			if (typeof flag !== "string" || !isAbsolute(flag)) throw new Error("Invalid subagent launch descriptor path");
			descriptor = await readLaunchDescriptor(flag);
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
			if (descriptor) {
				try {
					await writeStartupReceipt(descriptor.receiptPath, {
						version: 1,
						token: descriptor.token,
						ready: false,
						error: message,
					});
				} catch {
					/* Missing receipt also fails closed. */
				}
			}
			try {
				process.stderr.write(`Subagent startup failed: ${message}\n`);
			} catch {
				/* Never admit rejected input. */
			}
			return { action: "handled" };
		}
	});
}
