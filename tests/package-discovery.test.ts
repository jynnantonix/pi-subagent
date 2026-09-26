import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("local package discovers only the subagent entry point", async () => {
	const isolated = await mkdtemp(join(tmpdir(), "pi-subagent-package-"));
	try {
		const previous = process.env.PI_SUBAGENT;
		try {
			for (const [marker, expected] of [
				[undefined, ["subagent"]],
				["0", ["subagent"]],
				["1", []],
			] as const) {
				if (marker === undefined) delete process.env.PI_SUBAGENT;
				else process.env.PI_SUBAGENT = marker;
				const loader = new DefaultResourceLoader({
					cwd: isolated,
					agentDir: join(isolated, "agent"),
					settingsManager: SettingsManager.inMemory({ packages: [packageRoot] }),
				});
				await loader.reload();
				const { extensions, errors } = loader.getExtensions();
				assert.deepEqual(errors, []);
				assert.deepEqual(
					extensions.map((extension) => extension.resolvedPath),
					[join(packageRoot, "index.ts")],
				);
				const tools = extensions.flatMap((extension) => [...extension.tools.values()]);
				assert.deepEqual(
					tools.map((tool) => tool.definition.name),
					expected,
				);
				if (marker !== "1") {
					const schema = tools[0]!.definition.parameters;
					assert.ok("properties" in schema && typeof schema.properties === "object" && schema.properties !== null);
					assert.ok(Object.hasOwn(schema.properties, "resume"));
				}
			}
		} finally {
			if (previous === undefined) delete process.env.PI_SUBAGENT;
			else process.env.PI_SUBAGENT = previous;
		}
	} finally {
		await rm(isolated, { recursive: true, force: true });
	}
});
