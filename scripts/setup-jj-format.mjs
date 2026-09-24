import { accessSync, constants, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const prettierExecutable = join(repoRoot, "node_modules", ".bin", "prettier");

try {
  accessSync(realpathSync(prettierExecutable), constants.X_OK);
} catch {
  console.error("Local Prettier is unavailable. Run npm install --ignore-scripts first.");
  process.exit(1);
}

const settings = [
  ["fix.tools.prettier.command", JSON.stringify(["$root/node_modules/.bin/prettier", "--stdin-filepath=$path"])],
  [
    "fix.tools.prettier.patterns",
    JSON.stringify([
      "glob:'**/*.ts'",
      "glob:'**/*.mjs'",
      "glob:'**/*.json' ~ file:'package-lock.json'",
      "glob:'**/*.md'",
    ]),
  ],
];

for (const [name, value] of settings) {
  const result = spawnSync("jj", ["-R", repoRoot, "config", "set", "--repo", name, value], {
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
