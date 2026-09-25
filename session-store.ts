import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { lstat, link, mkdir, open, readFile, rename, rmdir, unlink } from "node:fs/promises";
import type { Stats } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

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
const ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?-[0-9a-f]{8}$/;
export function isPublicSessionId(id: string): boolean {
	return ID.test(id);
}
const slug = (name: string) =>
	name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.slice(0, 64)
		.replace(/^-+|-+$/g, "") || "agent";
const invalid = (field: string): never => {
	throw new Error(`invalid ${field}`);
};
const object = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === "string";
const nonempty = (value: unknown): value is string => string(value) && value.length > 0;
const absolute = (value: unknown): value is string => nonempty(value) && isAbsolute(value) && resolve(value) === value;
const timestamp = (value: unknown): value is string =>
	string(value) &&
	/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
	!Number.isNaN(Date.parse(value)) &&
	new Date(value).toISOString() === value;
const codeIs = (error: unknown, code: string): boolean => object(error) && error.code === code;
const ioError = (operation: string, id: string, error: unknown): Error =>
	new Error(`${operation} for ${id}: ${String(error)}`, { cause: error });

export function sessionPaths(root: string, id: string): SessionPaths {
	if (!isAbsolute(root) || resolve(root) !== root || !isPublicSessionId(id)) invalid("session path or ID");
	const dir = join(root, id);
	if (!dir.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) invalid("session containment");
	return {
		root,
		id,
		dir,
		config: join(dir, "config.json"),
		transcript: join(dir, "session.jsonl"),
		lock: join(dir, ".lock"),
	};
}
async function directory(path: string, id: string): Promise<void> {
	const stat = await lstat(path).catch((error: unknown) => {
		throw ioError("inspect directory", id, error);
	});
	if (!stat.isDirectory() || stat.isSymbolicLink()) invalid(`symlink or directory for ${id}`);
}
async function safeRoot(root: string, id: string, create: boolean): Promise<void> {
	if (!isAbsolute(root) || resolve(root) !== root) invalid("root");
	const parts = root.split(sep).filter(Boolean);
	let path: string = sep;
	for (let i = 0; i < parts.length; i++) {
		path = join(path, parts[i]!);
		if (create && i === parts.length - 1) {
			try {
				await mkdir(path, { mode: 0o700 });
			} catch (error) {
				if (!codeIs(error, "EEXIST")) throw ioError("create root", id, error);
			}
		}
		await directory(path, id);
	}
	const stat = await lstat(root);
	if ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) invalid("private root");
}
async function safeSession(paths: SessionPaths): Promise<void> {
	if (
		join(paths.root, paths.id) !== paths.dir ||
		paths.config !== join(paths.dir, "config.json") ||
		paths.transcript !== join(paths.dir, "session.jsonl") ||
		paths.lock !== join(paths.dir, ".lock")
	)
		invalid("paths");
	sessionPaths(paths.root, paths.id);
	await safeRoot(paths.root, paths.id, false);
	await directory(paths.dir, paths.id);
}
async function regular(path: string, id: string): Promise<void> {
	const stat = await lstat(path).catch((error: unknown) => {
		throw ioError("inspect file", id, error);
	});
	if (!stat.isFile() || stat.isSymbolicLink()) invalid(`symlink or file for ${id}`);
}
const prepared = new Set<string>();
export async function allocateSession(
	root: string,
	agentName: string,
	randomSuffix: () => string = () => randomBytes(4).toString("hex"),
): Promise<SessionPaths> {
	await safeRoot(root, "new session", true);
	for (let attempt = 0; attempt < 16; attempt++) {
		const tail = randomSuffix();
		if (!/^[0-9a-f]{8}$/.test(tail)) invalid("random suffix");
		const paths = sessionPaths(root, `${slug(agentName)}-${tail}`);
		try {
			await mkdir(paths.dir, { mode: 0o700 });
			prepared.add(paths.dir);
			return paths;
		} catch (error) {
			if (!codeIs(error, "EEXIST")) throw ioError("allocate", paths.id, error);
		}
	}
	throw new Error("session allocation failed after 16 collisions");
}
const configKeys = [
	"version",
	"id",
	"piSessionId",
	"name",
	"source",
	"definitionPath",
	"discoveryCwd",
	"projectAgentsDir",
	"cwd",
	"systemPrompt",
	"provider",
	"model",
	"thinkingLevel",
	"tools",
];
const levels: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export function parseSavedConfig(value: unknown): SavedConfig {
	if (!object(value)) throw new Error("invalid saved config");
	if (
		Object.keys(value).some((key) => !configKeys.includes(key)) ||
		Object.keys(value).length !== configKeys.length ||
		value.version !== 1 ||
		!string(value.id) ||
		!ID.test(value.id) ||
		!nonempty(value.piSessionId) ||
		!nonempty(value.name) ||
		(value.source !== "user" && value.source !== "project") ||
		!absolute(value.definitionPath) ||
		!absolute(value.discoveryCwd) ||
		!absolute(value.cwd) ||
		!string(value.systemPrompt) ||
		!nonempty(value.provider) ||
		!nonempty(value.model) ||
		!string(value.thinkingLevel) ||
		!levels.includes(value.thinkingLevel) ||
		!Array.isArray(value.tools) ||
		!value.tools.every(nonempty) ||
		new Set(value.tools).size !== value.tools.length ||
		(value.source === "user" ? value.projectAgentsDir !== null : !absolute(value.projectAgentsDir))
	)
		invalid("saved config");
	return {
		version: 1,
		id: value.id,
		piSessionId: value.piSessionId,
		name: value.name,
		source: value.source,
		definitionPath: value.definitionPath,
		discoveryCwd: value.discoveryCwd,
		projectAgentsDir: value.projectAgentsDir,
		cwd: value.cwd,
		systemPrompt: value.systemPrompt,
		provider: value.provider,
		model: value.model,
		thinkingLevel: value.thinkingLevel,
		tools: value.tools,
	} as SavedConfig;
}
export async function readSavedConfig(paths: SessionPaths): Promise<SavedConfig> {
	await safeSession(paths);
	await regular(paths.config, paths.id);
	return withFileMutationQueue(paths.config, async () => {
		let value: unknown;
		try {
			value = JSON.parse(await readFile(paths.config, "utf8"));
		} catch (error) {
			throw ioError("read config", paths.id, error);
		}
		const config = parseSavedConfig(value);
		if (config.id !== paths.id) invalid("saved config ID");
		return config;
	});
}
type Owner = { token: string; controllerPid: number; acquiredAt: string; childPid: number | null };
function parseOwner(value: unknown): Owner {
	if (!object(value)) throw new Error("invalid lock owner");
	if (
		!nonempty(value.token) ||
		!Number.isSafeInteger(value.controllerPid) ||
		!timestamp(value.acquiredAt) ||
		(value.childPid !== null && !Number.isSafeInteger(value.childPid))
	)
		invalid("lock owner");
	return {
		token: value.token as string,
		controllerPid: value.controllerPid as number,
		acquiredAt: value.acquiredAt as string,
		childPid: value.childPid as number | null,
	};
}
async function owner(paths: SessionPaths): Promise<Owner> {
	await safeSession(paths);
	await directory(paths.lock, paths.id);
	const file = join(paths.lock, "owner.json");
	await regular(file, paths.id);
	return parseOwner(JSON.parse(await readFile(file, "utf8")));
}
async function owned(paths: SessionPaths, token: string): Promise<Owner> {
	const current = await owner(paths);
	if (current.token !== token) throw new Error(`lease owner token mismatch for ${paths.id}`);
	return current;
}
function sameFile(a: Stats, b: Stats): boolean {
	return a.dev === b.dev && a.ino === b.ino;
}
export async function acquireLease(paths: SessionPaths): Promise<SessionLease> {
	await safeSession(paths);
	try {
		await mkdir(paths.lock, { mode: 0o700 });
	} catch (error) {
		if (codeIs(error, "EEXIST")) throw new Error(`conversation busy: ${paths.id}`);
		throw ioError("acquire lease", paths.id, error);
	}
	const token = randomUUID();
	const file = join(paths.lock, "owner.json");
	let lockStat: Stats | undefined;
	let ownerStat: Stats | undefined;
	try {
		lockStat = await lstat(paths.lock);
		const handle = await fs.open(file, "wx", 0o600);
		try {
			ownerStat = await handle.stat();
			await handle.writeFile(
				JSON.stringify({ token, controllerPid: process.pid, acquiredAt: new Date().toISOString(), childPid: null }),
			);
		} finally {
			await handle.close();
		}
	} catch (error) {
		try {
			// The newly created lock and owner inode prove cleanup ownership even if
			// the owner write stopped halfway through JSON. Never remove a replacement.
			const currentLock = await lstat(paths.lock);
			if (lockStat && sameFile(currentLock, lockStat) && currentLock.isDirectory()) {
				if (ownerStat) {
					const currentOwner = await lstat(file);
					if (!sameFile(currentOwner, ownerStat) || !currentOwner.isFile()) throw new Error("owner replaced");
					let candidate: unknown;
					try {
						candidate = JSON.parse(await readFile(file, "utf8"));
					} catch {
						// A partial write has no published owner, but its inode is ours.
					}
					if (object(candidate) && candidate.token !== token) throw new Error("owner replaced");
					await unlink(file);
				}
				await rmdir(paths.lock);
			}
		} catch {
			/* An uncertain or replaced lock stays busy. */
		}
		throw ioError("initialize lease", paths.id, error);
	}
	let released = false;
	return {
		paths,
		token,
		async recordChild(pid: number) {
			if (!Number.isSafeInteger(pid) || pid <= 0) invalid("child PID");
			await withFileMutationQueue(file, async () => {
				const current = await owned(paths, token);
				if (current.childPid !== null) throw new Error(`child already recorded for ${paths.id}`);
				const temp = join(paths.lock, `.${randomUUID()}.tmp`);
				try {
					const handle = await open(temp, "wx", 0o600);
					try {
						await handle.writeFile(JSON.stringify({ ...current, childPid: pid }));
					} finally {
						await handle.close();
					}
					await owned(paths, token);
					await rename(temp, file);
				} finally {
					await unlink(temp).catch((error: unknown) => {
						if (!codeIs(error, "ENOENT")) throw error;
					});
				}
			});
		},
		async release() {
			if (released) return;
			await withFileMutationQueue(file, async () => {
				try {
					await owned(paths, token);
				} catch (error) {
					if (codeIs((error as Error).cause, "ENOENT")) {
						released = true;
						return;
					}
					throw error;
				}
				await unlink(file);
				await rmdir(paths.lock);
				prepared.delete(paths.dir);
				released = true;
			});
		},
	};
}
export async function prepareTranscript(lease: SessionLease): Promise<void> {
	const { paths, token } = lease;
	if (!prepared.has(paths.dir)) throw new Error(`new lease required for ${paths.id}`);
	await owned(paths, token);
	await withFileMutationQueue(paths.transcript, async () => {
		const handle = await open(paths.transcript, "wx", 0o600);
		await handle.close();
	});
	prepared.delete(paths.dir);
}
export async function publishSavedConfig(paths: SessionPaths, ownerToken: string, input: SavedConfig): Promise<void> {
	const config = parseSavedConfig(input);
	if (config.id !== paths.id) invalid("saved config ID");
	await owned(paths, ownerToken);
	await withFileMutationQueue(paths.config, async () => {
		await owned(paths, ownerToken);
		const temp = join(paths.dir, `.${randomUUID()}.tmp`);
		try {
			const handle = await open(temp, "wx", 0o600);
			try {
				await handle.writeFile(JSON.stringify(config));
			} finally {
				await handle.close();
			}
			await link(temp, paths.config);
		} catch (error) {
			throw ioError("publish config", paths.id, error);
		} finally {
			await unlink(temp).catch((error: unknown) => {
				if (!codeIs(error, "ENOENT")) throw error;
			});
		}
	});
}

const textBlock = (part: unknown): boolean => object(part) && part.type === "text" && string(part.text);
const imageBlock = (part: unknown): boolean =>
	object(part) && part.type === "image" && string(part.data) && string(part.mimeType);
const thinkingBlock = (part: unknown): boolean => object(part) && part.type === "thinking" && string(part.thinking);
const toolCallBlock = (part: unknown): boolean =>
	object(part) && part.type === "toolCall" && nonempty(part.id) && nonempty(part.name) && object(part.arguments);
const blocks = (value: unknown, accepts: (part: unknown) => boolean): boolean =>
	Array.isArray(value) && value.every(accepts);
const userContent = (value: unknown): boolean =>
	string(value) || blocks(value, (part) => textBlock(part) || imageBlock(part));
const assistantContent = (value: unknown): boolean =>
	blocks(value, (part) => textBlock(part) || thinkingBlock(part) || toolCallBlock(part));
// ContextEditableContent is the union of the four pinned content fields, not
// the user-content field alone. The target role is resolved later by Pi.
const editableContent = (value: unknown): boolean => userContent(value) || assistantContent(value);
const systemMessage = (value: Record<string, unknown>): boolean =>
	value.role === "system" &&
	(string(value.content) || blocks(value.content, textBlock)) &&
	(!("sections" in value) ||
		(object(value.sections) &&
			Object.values(value.sections).every((section) => section === null || string(section)))) &&
	(!("toolsAdded" in value) ||
		blocks(
			value.toolsAdded,
			(tool) => object(tool) && nonempty(tool.name) && string(tool.description) && object(tool.parameters),
		)) &&
	(!("toolsRemoved" in value) || blocks(value.toolsRemoved, (tool) => object(tool) && nonempty(tool.name)));
function usage(value: unknown): boolean {
	return (
		object(value) &&
		["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every(
			(key) => typeof value[key] === "number" && Number.isFinite(value[key]),
		) &&
		object(value.cost) &&
		["input", "output", "cacheRead", "cacheWrite", "total"].every(
			(key) => typeof (value.cost as Record<string, unknown>)[key] === "number",
		)
	);
}
function message(value: unknown): boolean {
	if (!object(value) || typeof value.timestamp !== "number") return false;
	switch (value.role) {
		case "system":
			return systemMessage(value);
		case "user":
			return userContent(value.content);
		case "assistant":
			return (
				assistantContent(value.content) &&
				nonempty(value.api) &&
				nonempty(value.provider) &&
				nonempty(value.model) &&
				usage(value.usage) &&
				string(value.stopReason) &&
				["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"].includes(value.stopReason)
			);
		case "toolResult":
			return (
				nonempty(value.toolCallId) &&
				nonempty(value.toolName) &&
				Array.isArray(value.content) &&
				value.content.every((part: unknown) => textBlock(part) || imageBlock(part)) &&
				typeof value.isError === "boolean"
			);
		case "custom":
			return userContent(value.content) && nonempty(value.customType) && typeof value.display === "boolean";
		case "bashExecution":
			return (
				string(value.command) &&
				string(value.output) &&
				(value.exitCode === undefined || typeof value.exitCode === "number") &&
				typeof value.cancelled === "boolean" &&
				typeof value.truncated === "boolean"
			);
		default:
			return false;
	}
}
function entry(value: Record<string, unknown>): boolean {
	switch (value.type) {
		case "message":
			return message(value.message);
		case "model_change":
			return nonempty(value.provider) && nonempty(value.modelId);
		case "thinking_level_change":
			return nonempty(value.thinkingLevel);
		case "usage":
			return nonempty(value.kind) && nonempty(value.provider) && nonempty(value.model) && usage(value.usage);
		case "compaction":
			return (
				string(value.summary) &&
				nonempty(value.firstKeptEntryId) &&
				typeof value.tokensBefore === "number" &&
				(!("systemMessage" in value) ||
					(object(value.systemMessage) && message(value.systemMessage) && value.systemMessage.role === "system"))
			);
		case "context_edit":
			return (
				nonempty(value.targetId) &&
				(value.replacement === null || (object(value.replacement) && editableContent(value.replacement.content)))
			);
		case "branch_summary":
			return nonempty(value.fromId) && string(value.summary);
		case "custom":
			return nonempty(value.customType);
		case "custom_message":
			return nonempty(value.customType) && userContent(value.content) && typeof value.display === "boolean";
		case "label":
			return nonempty(value.targetId) && (value.label === undefined || string(value.label));
		case "session_info":
			return value.name === undefined || string(value.name);
		default:
			return false;
	}
}
export async function validateTranscript(paths: SessionPaths, config: SavedConfig): Promise<void> {
	await safeSession(paths);
	if (parseSavedConfig(config).id !== paths.id) invalid("config ID");
	await regular(paths.transcript, paths.id);
	await withFileMutationQueue(paths.transcript, async () => {
		const text = await readFile(paths.transcript, "utf8");
		const lines = text.split("\n").filter((line) => line.trim() !== "");
		if (!lines.length || !text.endsWith("\n")) invalid("empty or truncated transcript");
		const parents = new Map<string, string | null>();
		for (const [index, line] of lines.entries()) {
			let value: unknown;
			try {
				value = JSON.parse(line);
			} catch {
				invalid(`transcript line ${index + 1}`);
			}
			if (!object(value)) throw new Error(`invalid transcript line ${index + 1}`);
			if (index === 0) {
				if (
					value.type !== "session" ||
					value.version !== 3 ||
					value.id !== config.piSessionId ||
					value.cwd !== config.cwd ||
					!timestamp(value.timestamp) ||
					(value.parentSession !== undefined && !absolute(value.parentSession))
				)
					invalid("transcript header");
				continue;
			}
			if (
				!nonempty(value.id) ||
				parents.has(value.id) ||
				!(value.parentId === null || (nonempty(value.parentId) && parents.has(value.parentId))) ||
				!timestamp(value.timestamp) ||
				!entry(value)
			)
				invalid(`transcript entry ${index + 1}`);
			if (value.type === "compaction" && value.firstKeptEntryId !== value.id) {
				// Pi 0.87.1 keeps only entries on this compaction's earlier path;
				// a target elsewhere silently becomes retain-none. Check links, not context.
				let ancestor = value.parentId as string | null;
				while (ancestor !== null && ancestor !== value.firstKeptEntryId) ancestor = parents.get(ancestor)!;
				if (ancestor === null) invalid(`transcript compaction target at entry ${index + 1}`);
			}
			parents.set(value.id as string, value.parentId as string | null);
		}
	});
}
