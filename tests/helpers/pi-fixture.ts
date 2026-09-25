import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { TestContext } from "node:test";
import type { ChildRuntime, LaunchIntent } from "../../child-launch.ts";

const packageDir = dirname(
	resolve(import.meta.dirname, "../../node_modules/@earendil-works/pi-coding-agent/package.json"),
);
export async function createPiFixture(t: TestContext) {
	const home = await mkdtemp(join(tmpdir(), "pi-subagent-child-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const agentDir = join(home, "agent");
	const cwd = join(home, "work");
	const root = join(agentDir, "subagent-sessions");
	const definitionPath = join(home, "reviewer.md");
	const log = join(home, "provider.jsonl");
	await mkdir(join(agentDir, "extensions"), { recursive: true });
	await mkdir(cwd);
	await symlink(resolve(import.meta.dirname, "../../node_modules"), join(agentDir, "node_modules"), "dir");
	await cp(
		resolve(import.meta.dirname, "../fixtures/fixture-provider.ts"),
		join(agentDir, "extensions/fixture-provider.ts"),
	);
	await writeFile(definitionPath, "Fixture reviewer prompt.\n");
	await writeFile(
		join(agentDir, "settings.json"),
		JSON.stringify({
			defaultProvider: "fixture",
			defaultModel: "reviewer",
			defaultThinkingLevel: "high",
			defaultTools: ["read", "grep"],
			compaction: { enabled: false },
			retry: { enabled: false },
			cacheWarming: "off",
		}),
	);
	const env: NodeJS.ProcessEnv = {
		HOME: home,
		PI_CODING_AGENT_DIR: agentDir,
		PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1",
		PI_TELEMETRY: "0",
		FIXTURE_LOG: log,
		PATH: process.env.PATH,
		TMPDIR: tmpdir(),
		LANG: "C.UTF-8",
	};
	const runtime: ChildRuntime = {
		invocation: { command: process.execPath, prefixArgs: [join(packageDir, "dist/cli.js")] },
		env,
		bootstrapPath: resolve(import.meta.dirname, "../../child-bootstrap.ts"),
		killGraceMs: 80,
	};
	const newIntent: LaunchIntent = {
		kind: "new",
		identity: {
			name: "reviewer",
			source: "user",
			definitionPath,
			discoveryCwd: cwd,
			projectAgentsDir: null,
			cwd,
			systemPrompt: "Fixture reviewer prompt.\n",
		},
		requestedModel: "fixture/reviewer:high",
	};
	return {
		home,
		agentDir,
		cwd,
		root,
		log,
		definitionPath,
		env,
		runtime,
		newIntent,
		async orchestrate(scenario: string) {
			const child = spawn(
				process.execPath,
				[
					"--import",
					resolve(import.meta.dirname, "../../node_modules/tsx/dist/loader.mjs"),
					resolve(import.meta.dirname, "../fixtures/orchestration-runner.ts"),
					scenario,
				],
				{ cwd, env, stdio: ["ignore", "pipe", "pipe"] },
			);
			let stdout = "",
				stderr = "";
			child.stdout.on("data", (data: Buffer) => {
				stdout += data.toString();
			});
			child.stderr.on("data", (data: Buffer) => {
				stderr += data.toString();
			});
			const exit = await new Promise<number | null>((done) => child.on("close", done));
			return { exit, stdout, stderr };
		},
		async controller(params: Record<string, unknown>, controllerTask = "controller-task") {
			// A fresh Pi process and native controller session for each call. No prior controller state is passed.
			const args = [
				join(packageDir, "dist/cli.js"),
				"--mode",
				"json",
				"-p",
				"--no-session",
				"--extension",
				resolve(import.meta.dirname, "../../index.ts"),
				"--model",
				"fixture/other",
				"--tools",
				"subagent",
				`controller-case:${JSON.stringify({ params, controllerTask })}`,
			];
			const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "",
				stderr = "";
			child.stdout.on("data", (data: Buffer) => {
				stdout += data.toString();
			});
			child.stderr.on("data", (data: Buffer) => {
				stderr += data.toString();
			});
			const exit = await new Promise<number | null>((done) => child.on("close", done));
			const events = stdout
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
			return {
				events,
				exit,
				stderr,
				tool: events.filter((event) => event.type === "message_end" && event.message?.role === "toolResult").at(-1)
					?.message,
				answer: events.filter((event) => event.type === "message_end" && event.message?.role === "assistant").at(-1)
					?.message,
			};
		},
		async providerCalls(): Promise<any[]> {
			return (await readFile(log, "utf8").catch(() => ""))
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
		},
		async changeDefaultsAndRemoveDefinition() {
			await rm(definitionPath);
			await writeFile(
				join(agentDir, "settings.json"),
				JSON.stringify({
					defaultProvider: "fixture",
					defaultModel: "other",
					defaultThinkingLevel: "low",
					defaultTools: ["bash"],
					compaction: { enabled: false },
					retry: { enabled: false },
					cacheWarming: "off",
				}),
			);
		},
	};
}
