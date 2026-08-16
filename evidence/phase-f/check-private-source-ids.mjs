import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const excludedDirectories = new Set([".git", ".cache", "coverage", "dist", "node_modules"]);
const textExtensions = new Set([
  ".cjs", ".css", ".html", ".js", ".json", ".md", ".mjs", ".mts",
  ".sh", ".toml", ".ts", ".tsx", ".yaml", ".yml",
]);
const codexSourceId = /\b019[0-9a-f]{5}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu;
const findings = [];
const pending = [repositoryRoot];

while (pending.length > 0) {
  const current = pending.pop();
  if (current === undefined) break;
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const absolute = resolve(current, entry.name);
    if (entry.isDirectory()) {
      if (!excludedDirectories.has(entry.name)) pending.push(absolute);
      continue;
    }
    if (!entry.isFile() || !textExtensions.has(extname(entry.name))) continue;
    const metadata = await lstat(absolute);
    if (metadata.size > 2 * 1_048_576) continue;
    if (codexSourceId.test(await readFile(absolute, "utf8"))) {
      findings.push(absolute.slice(repositoryRoot.length + 1));
    }
  }
}

if (findings.length > 0) {
  process.stderr.write(`Private Codex source identifiers found in: ${findings.sort().join(", ")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Private Codex source identifier scan passed.\n");
}
