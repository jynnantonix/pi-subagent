import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SavedConfig, SessionPaths } from "../../session-store.ts";

export async function temporaryRoot(t: TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-subagent-store-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

export function savedConfig(paths: SessionPaths, overrides: Partial<SavedConfig> = {}): SavedConfig {
	return {
		version: 1,
		id: paths.id,
		piSessionId: "native-session-id",
		name: "Reviewer",
		source: "user",
		definitionPath: join(paths.root, "reviewer.md"),
		discoveryCwd: paths.root,
		projectAgentsDir: null,
		cwd: paths.root,
		systemPrompt: "Review the code",
		provider: "example",
		model: "example-model",
		thinkingLevel: "off",
		tools: ["read", "bash"],
		...overrides,
	};
}

export async function nativeSession(paths: SessionPaths): Promise<SavedConfig> {
	const manager = SessionManager.create(paths.root, paths.dir, { id: "native-session-id" });
	manager.appendMessage({ role: "user", content: "Review", timestamp: Date.now() });
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "Done" }],
		api: "test",
		provider: "example",
		model: "example-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
	manager.appendMessage({
		role: "bashExecution",
		command: "pwd",
		output: paths.root,
		exitCode: 0,
		cancelled: false,
		truncated: false,
		timestamp: Date.now(),
	});
	manager.appendUsage("cache_warm", "example", "example-model", {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	});
	manager.appendCustomEntry("fixture", { ok: true });
	manager.appendCustomMessageEntry("fixture", "context", false);
	manager.appendCompaction("summary", null, 10);
	manager.appendContextEdit(manager.getEntries()[0]!.id, null);
	manager.appendContextEdit(manager.getEntries()[1]!.id, {
		content: [
			{ type: "thinking", thinking: "Consider the options", thinkingSignature: "opaque" },
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "example.ts" } },
			{ type: "text", text: "Done" },
		],
	});
	manager.appendMessage({
		role: "system",
		content: [{ type: "text", text: "Updated instructions" }],
		sections: { preamble: "You are a reviewer", obsolete: null },
		toolsAdded: [{ name: "read", description: "Read files", parameters: { type: "object", properties: {} } }],
		toolsRemoved: [{ name: "write" }],
		timestamp: Date.now(),
	});
	manager.appendCompaction("checkpoint", null, 20);
	const { copyFile } = await import("node:fs/promises");
	await copyFile(manager.getSessionFile()!, paths.transcript);
	// The public appendCompaction API does not accept a checkpoint; Pi persists one
	// during actual compaction. Add that pinned native field to the Pi-created entry.
	const { readFile, writeFile } = await import("node:fs/promises");
	const lines = (await readFile(paths.transcript, "utf8")).trimEnd().split("\n");
	const checkpoint = JSON.parse(lines.at(-1)!);
	checkpoint.systemMessage = {
		role: "system",
		content: "Current prompt",
		sections: { preamble: "You are a reviewer", obsolete: null },
		toolsAdded: [{ name: "read", description: "Read files", parameters: { type: "object", properties: {} } }],
		toolsRemoved: [{ name: "write" }],
		timestamp: Date.now(),
	};
	lines[lines.length - 1] = JSON.stringify(checkpoint);
	await writeFile(paths.transcript, `${lines.join("\n")}\n`);
	return savedConfig(paths);
}
