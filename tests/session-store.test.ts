import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import test from "node:test";
import {
	allocateSession,
	acquireLease,
	parseSavedConfig,
	prepareTranscript,
	publishSavedConfig,
	readSavedConfig,
	sessionPaths,
	validateTranscript,
} from "../session-store.ts";
import { nativeSession, savedConfig, temporaryRoot } from "./helpers/fixtures.ts";

test("allocation retries collisions; a lease excludes a second writer", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-subagent-store-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const first = await allocateSession(root, "Reviewer", () => "a1b2c3d4");
	const suffixes = ["a1b2c3d4", "b1b2c3d4"];
	const second = await allocateSession(root, "Reviewer", () => suffixes.shift()!);
	assert.equal(first.id, "reviewer-a1b2c3d4");
	assert.equal(second.id, "reviewer-b1b2c3d4");
	const lease = await acquireLease(first);
	await assert.rejects(acquireLease(first), /busy/);
	await lease.release();
	await (await acquireLease(first)).release();
	for (const bad of ["../reviewer-a1b2c3d4", "/tmp/x", "reviewer-DEADBEEF", " reviewer-a1b2c3d4"])
		assert.throws(() => sessionPaths(root, bad), /invalid/i);
});

// Removing ID validation or exclusive creation must make this test fail.
test("IDs reject unsafe names and paths without creating unknown sessions", async (t) => {
	const root = await temporaryRoot(t);
	for (const name of ["", "🌍"]) assert.match((await allocateSession(root, name)).id, /^agent-[0-9a-f]{8}$/);
	const long = await allocateSession(root, "R".repeat(100), () => "a1b2c3d4");
	assert.equal(long.id.split("-")[0]!.length, 64);
	await allocateSession(root, "collision", () => "a1b2c3d4");
	await allocateSession(root, "retry", () => "d1b2c3d4");
	await assert.rejects(
		allocateSession(root, "retry", () => "d1b2c3d4"),
		/16|collision/i,
	);
	await assert.rejects(
		allocateSession(root, "bad", () => "DEADBEEF"),
		/invalid/i,
	);
	const missing = sessionPaths(root, "unknown-a1b2c3d4");
	await assert.rejects(acquireLease(missing), /unknown|ENOENT/i);
	assert.equal((await readdir(root)).includes(missing.id), false);
});

// Removing POSIX permissions or symlink checks must make this test fail.
test("private storage refuses symlinked components", async (t) => {
	const root = await temporaryRoot(t);
	await chmod(root, 0o755);
	await assert.rejects(
		allocateSession(root, "exposed", () => "a1b2c3d4"),
		/private|invalid/i,
	);
	await chmod(root, 0o700);
	const paths = await allocateSession(root, "privacy", () => "a1b2c3d4");
	const lease = await acquireLease(paths);
	assert.equal((await lstat(paths.dir)).mode & 0o777, 0o700);
	assert.equal((await lstat(paths.lock)).mode & 0o777, 0o700);
	assert.equal((await lstat(join(paths.lock, "owner.json"))).mode & 0o777, 0o600);
	await prepareTranscript(lease);
	assert.equal((await lstat(paths.transcript)).mode & 0o777, 0o600);
	await publishSavedConfig(paths, lease.token, savedConfig(paths));
	assert.equal((await lstat(paths.config)).mode & 0o777, 0o600);
	await lease.release();
	for (const file of [paths.config, paths.transcript]) {
		const data = await readFile(file);
		await rm(file);
		await symlink(paths.dir, file);
		await assert.rejects(
			file === paths.config ? readSavedConfig(paths) : validateTranscript(paths, savedConfig(paths)),
			/symlink|invalid/i,
		);
		await rm(file);
		await writeFile(file, data);
	}
	const other = await allocateSession(root, "other", () => "a1b2c3d4");
	await rm(other.dir, { recursive: true });
	await symlink(paths.dir, other.dir);
	await assert.rejects(acquireLease(other), /symlink|invalid/i);
	const third = await allocateSession(root, "third", () => "a1b2c3d4");
	const thirdLease = await acquireLease(third);
	const ownerFile = join(third.lock, "owner.json");
	const validOwner = join(third.dir, "valid-owner.json");
	const before = await readFile(ownerFile);
	assert.equal(JSON.parse(before.toString("utf8")).token, thirdLease.token);
	await writeFile(validOwner, before);
	await rm(ownerFile);
	await symlink(validOwner, ownerFile);
	await assert.rejects(thirdLease.release(), /invalid symlink or file/i);
	assert.equal((await lstat(ownerFile)).isSymbolicLink(), true);
	assert.deepEqual(await readFile(validOwner), before);
	assert.equal((await lstat(third.lock)).isDirectory(), true);
});

// Removing snapshot validation, immutable publication, or owner checks must make this test fail.
test("snapshots validate provenance and are immutable under the owned lease", async (t) => {
	const paths = await allocateSession(await temporaryRoot(t), "snapshot", () => "a1b2c3d4");
	const lease = await acquireLease(paths);
	const config = savedConfig(paths);
	for (const bad of [
		{ version: 2 },
		{ tools: ["read", "read"] },
		{ cwd: "relative" },
		{ definitionPath: "relative" },
		{ source: "project" },
		{ projectAgentsDir: paths.root },
		{ provider: 42 },
		{ thinkingLevel: ["off"] },
		{ thinkingLevel: { value: "off" } },
		{ credentials: "secret" },
	])
		assert.throws(() => parseSavedConfig({ ...config, ...bad }), /invalid/i);
	assert.deepEqual(parseSavedConfig(config), config);
	await assert.rejects(publishSavedConfig(paths, lease.token, { ...config, id: "wrong-a1b2c3d4" }), /invalid/i);
	await assert.rejects(publishSavedConfig(paths, "wrong", config), /owner|token/i);
	await publishSavedConfig(paths, lease.token, config);
	assert.deepEqual(await readSavedConfig(paths), config);
	await assert.rejects(publishSavedConfig(paths, lease.token, config), /exist|published/i);
	assert.equal((await readdir(paths.dir)).filter((file) => file.includes("tmp")).length, 0);
	await lease.release();
});

// Removing strict JSONL validation must make this test fail.
test("native history checks header, every record, and parent references without repair", async (t) => {
	const paths = await allocateSession(await temporaryRoot(t), "native", () => "a1b2c3d4");
	const config = await nativeSession(paths);
	await validateTranscript(paths, config);
	const original = await readFile(paths.transcript, "utf8");
	const lines = original.trimEnd().split("\n");
	const header = JSON.parse(lines[0]!);
	const entry = JSON.parse(lines[1]!);
	for (const contents of [
		"",
		"{}\n",
		"{\n",
		`${JSON.stringify({ ...header, cwd: "/wrong" })}\n${lines.slice(1).join("\n")}\n`,
		`${JSON.stringify({ ...header, id: "wrong" })}\n${lines.slice(1).join("\n")}\n`,
		`${original}{`,
		`${original}{}\n`,
		`${original}${lines[1]}\n`,
		`${original}${JSON.stringify({ ...entry, id: "another", parentId: "missing" })}\n`,
	]) {
		await writeFile(paths.transcript, contents);
		await assert.rejects(validateTranscript(paths, config), /invalid|missing|empty/i);
		assert.equal(await readFile(paths.transcript, "utf8"), contents);
	}
	await writeFile(paths.transcript, original);
});

// Removing native content/role field validation must make this test fail.
test("native context edits and system checkpoints validate their complete pinned shapes", async (t) => {
	const paths = await allocateSession(await temporaryRoot(t), "shapes", () => "a1b2c3d4");
	const config = await nativeSession(paths);
	const original = await readFile(paths.transcript, "utf8");
	await validateTranscript(paths, config);
	const lines = original.trimEnd().split("\n");
	const records = lines.map((line) => JSON.parse(line));
	const index = (predicate: (record: any) => boolean) => records.findIndex(predicate);
	const edit = index((record) => record.type === "context_edit" && record.replacement !== null);
	const system = index((record) => record.type === "message" && record.message.role === "system");
	const assistant = index((record) => record.type === "message" && record.message.role === "assistant");
	const checkpoint = index((record) => record.type === "compaction" && record.systemMessage);
	assert.ok([edit, system, assistant, checkpoint].every((position) => position > 0));
	for (const [position, change] of [
		[edit, (record: any) => (record.replacement.content[0] = { type: "thinking", thinking: [] })],
		[
			edit,
			(record: any) => (record.replacement.content[1] = { type: "toolCall", id: "call", name: "read", arguments: [] }),
		],
		[assistant, (record: any) => (record.message.stopReason = ["stop"])],
		[system, (record: any) => (record.message.content = [{ type: "image", data: "AA==", mimeType: "image/png" }])],
		[system, (record: any) => (record.message.sections = { preamble: 42 })],
		[system, (record: any) => (record.message.toolsAdded = [null])],
		[system, (record: any) => (record.message.toolsAdded = [{ name: "read", description: 42, parameters: {} }])],
		[system, (record: any) => (record.message.toolsRemoved = [{}])],
		[checkpoint, (record: any) => (record.systemMessage.role = "user")],
		[checkpoint, (record: any) => (record.systemMessage.toolsRemoved = [null])],
	] as const) {
		const changed = [...lines];
		const record = JSON.parse(changed[position]);
		change(record);
		changed[position] = JSON.stringify(record);
		const malformed = `${changed.join("\n")}\n`;
		await writeFile(paths.transcript, malformed);
		await assert.rejects(validateTranscript(paths, config), /invalid transcript entry/i);
		assert.equal(await readFile(paths.transcript, "utf8"), malformed);
	}
});

// Rejecting non-contract fields in native messages/checkpoints must make this test fail.
test("system messages and compaction checkpoints accept extra native fields", async (t) => {
	const paths = await allocateSession(await temporaryRoot(t), "extras", () => "a1b2c3d4");
	const config = await nativeSession(paths);
	const lines = (await readFile(paths.transcript, "utf8")).trimEnd().split("\n");
	let systemFound = false;
	let checkpointFound = false;
	const withExtras = lines.map((line) => {
		const record = JSON.parse(line);
		if (record.type === "message" && record.message.role === "system") {
			record.message.replace = "extension-metadata";
			systemFound = true;
		}
		if (record.type === "compaction" && record.systemMessage) {
			record.systemMessage.replace = "extension-metadata";
			checkpointFound = true;
		}
		return JSON.stringify(record);
	});
	assert.equal(systemFound && checkpointFound, true);
	const transcript = `${withExtras.join("\n")}\n`;
	await writeFile(paths.transcript, transcript);
	await validateTranscript(paths, config);
	assert.equal(await readFile(paths.transcript, "utf8"), transcript);
});

// Removing token checks or lease retention must make this test fail.
test("independent process owns the same lock until explicit release", async (t) => {
	const paths = await allocateSession(await temporaryRoot(t), "process", () => "a1b2c3d4");
	const child = fork(join(import.meta.dirname, "fixtures/process-probe.mjs"), [paths.root, paths.id], {
		execArgv: ["--import", "tsx"],
		stdio: ["ignore", "pipe", "pipe", "ipc"],
	});
	t.after(() => child.kill());
	await new Promise<void>((resolve, reject) => {
		child.once("message", (message) =>
			message && typeof message === "object" && "event" in message && message.event === "acquired"
				? resolve()
				: reject(new Error("probe did not acquire")),
		);
		child.once("error", reject);
		child.once("exit", (code) => reject(new Error(`probe exited ${code}`)));
	});
	await assert.rejects(acquireLease(paths), /busy/i);
	child.send("release");
	await new Promise<void>((resolve) => child.once("exit", () => resolve()));
	await (await acquireLease(paths)).release();
});

// Removing cleanup on owner-open/write failure must make this test fail;
// replacing the lock mid-failure must never delete the replacement.
test("unlaunched owner initialization failures remove only the newly owned lock", async (t) => {
	const root = await temporaryRoot(t);
	for (const phase of ["open", "write"] as const) {
		for (const replacementKind of ["none", "lock", ...(phase === "write" ? (["owner"] as const) : [])] as const) {
			const paths = await allocateSession(root, `${phase}-${replacementKind}`);
			const originalOpen = fs.open;
			let interrupted = false;
			const failure = Object.assign(new Error("injected disk full"), { code: "ENOSPC" });
			const replacement = join(paths.dir, ".replacement-lock");
			const injected = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
				if (String(args[0]) !== join(paths.lock, "owner.json") || interrupted) return originalOpen(...args);
				interrupted = true;
				if (phase === "open") {
					if (replacementKind === "lock") {
						await rename(paths.lock, replacement);
						await mkdir(paths.lock);
						await writeFile(join(paths.lock, "owner.json"), '{"token":"replacement"}');
					}
					throw failure;
				}
				const handle = await originalOpen(...args);
				const originalWrite = handle.writeFile.bind(handle);
				handle.writeFile = async (...writeArgs: Parameters<typeof handle.writeFile>) => {
					await originalWrite("{partial");
					if (replacementKind === "lock") {
						await rename(paths.lock, replacement);
						await mkdir(paths.lock);
						await writeFile(join(paths.lock, "owner.json"), '{"token":"replacement"}');
					} else if (replacementKind === "owner") {
						await rename(join(paths.lock, "owner.json"), join(paths.lock, "former-owner.json"));
						await writeFile(join(paths.lock, "owner.json"), '{"token":"replacement"}');
					}
					throw failure;
				};
				return handle;
			});
			try {
				await assert.rejects(acquireLease(paths), /initialize lease/i);
			} finally {
				injected.mock.restore();
			}
			assert.equal(interrupted, true);
			if (replacementKind !== "none") {
				assert.equal(await readFile(join(paths.lock, "owner.json"), "utf8"), '{"token":"replacement"}');
				await assert.rejects(acquireLease(paths), /busy/i);
				await rm(paths.lock, { recursive: true });
				if (replacementKind === "lock") await rm(replacement, { recursive: true });
			} else {
				await (await acquireLease(paths)).release();
			}
		}
	}
});

test("lease records child PID; changed ownership and orphan locks stay busy", async (t) => {
	const paths = await allocateSession(await temporaryRoot(t), "lease", () => "a1b2c3d4");
	const lease = await acquireLease(paths);
	await lease.recordChild(process.pid);
	assert.equal(JSON.parse(await readFile(join(paths.lock, "owner.json"), "utf8")).childPid, process.pid);
	const owner = JSON.parse(await readFile(join(paths.lock, "owner.json"), "utf8"));
	await writeFile(join(paths.lock, "owner.json"), JSON.stringify({ ...owner, token: "replacement" }));
	await assert.rejects(lease.release(), /owner|token/i);
	assert.equal((await lstat(paths.lock)).isDirectory(), true);
	await assert.rejects(acquireLease(paths), /busy/i);
	await rm(paths.lock, { recursive: true });
	await mkdir(paths.lock);
	await assert.rejects(acquireLease(paths), /busy/i);
	await rm(paths.lock, { recursive: true });
	const own = await acquireLease(paths);
	await own.release();
	await own.release();
	await assert.rejects(prepareTranscript(own), /owner|lease/i);
	const resumed = await acquireLease(paths);
	await assert.rejects(prepareTranscript(resumed), /new lease/i);
	await resumed.release();
});
