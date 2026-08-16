import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = join(repoRoot, "release", "runtime");
const serverEntry = join(runtimeRoot, "server.mjs");
const webRoot = join(runtimeRoot, "web");
const bundledMcpRoot = join(repoRoot, "web", "dist");

rmSync(runtimeRoot, { recursive: true, force: true });
rmSync(join(repoRoot, "web"), { recursive: true, force: true });
mkdirSync(runtimeRoot, { recursive: true, mode: 0o755 });

await build({
  entryPoints: [join(repoRoot, "apps", "server", "dist", "main.js")],
  outfile: serverEntry,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  banner: {
    js: 'import { createRequire as __agentFarmCreateRequire } from "node:module"; const require = __agentFarmCreateRequire(import.meta.url);',
  },
  external: ["better-sqlite3"],
  legalComments: "none",
});
cpSync(join(repoRoot, "apps", "web", "dist"), webRoot, { recursive: true });
mkdirSync(bundledMcpRoot, { recursive: true, mode: 0o755 });
for (const filename of ["mcp-resource.html", "mcp-resource.json"]) {
  cpSync(join(repoRoot, "apps", "web", "dist", filename), join(bundledMcpRoot, filename));
}

const gate = readFileSync(join(repoRoot, "packages", "codex-bridge", "dist", "gate.js"), "utf8");
const pin = /PHASE_A_BINARY_SHA256\s*=\s*["']([a-f0-9]{64})["']/u.exec(gate)?.[1];
if (!pin) throw new Error("Cannot build release: pinned Codex SHA-256 is unavailable.");

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const metadata = {
  schemaVersion: 1,
  product: "Agent Farm",
  version: JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version,
  requiredNode: "22.17.0",
  requiredCodex: "0.145.0",
  codexSha256: pin,
  serverSha256: sha256(serverEntry),
  webIndexSha256: sha256(join(webRoot, "index.html")),
};
writeFileSync(join(runtimeRoot, "release.json"), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o644 });
console.log(`Release runtime built at ${runtimeRoot}`);
