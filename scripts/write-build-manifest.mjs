import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BUILD_MANIFEST_VERSION = 1;

function hashBytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256File(filePath) {
  return hashBytes(readFileSync(filePath));
}

function walkFiles(root, result = []) {
  if (!existsSync(root)) return result;
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return result;
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const entryPath = join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    // Never hash generated/dependency trees into the source digest. Including
    // package dist output makes the manifest self-referential and allows a
    // stale generated file to invalidate an otherwise reproducible build.
    if (entry.name === "dist" || entry.name === "node_modules" || entry.name === ".git") continue;
    if (entry.isDirectory()) walkFiles(entryPath, result);
    else if (entry.isFile()) result.push(entryPath);
  }
  return result;
}

export function sourceFiles(repoRoot) {
  const roots = [
    join(repoRoot, "apps", "server", "src"),
    join(repoRoot, "apps", "web", "src"),
    join(repoRoot, "scripts"),
  ];
  const files = roots.flatMap((root) => walkFiles(root));
  const packagesRoot = join(repoRoot, "packages");
  if (existsSync(packagesRoot)) {
    for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      const packageRoot = join(packagesRoot, entry.name);
      files.push(...walkFiles(join(packageRoot, "src")));
      const packageManifest = join(packageRoot, "package.json");
      if (existsSync(packageManifest)) files.push(packageManifest);
    }
  }
  for (const relativePath of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json", "tsconfig.base.json"]) {
    const candidate = join(repoRoot, relativePath);
    if (existsSync(candidate)) files.push(candidate);
  }
  return [...new Set(files)].sort((a, b) => relative(repoRoot, a).localeCompare(relative(repoRoot, b)));
}

export function sourceDigest(repoRoot) {
  const entries = sourceFiles(repoRoot).map((filePath) => {
    const relativePath = relative(repoRoot, filePath).split("\\").join("/");
    return `${relativePath}\t${sha256File(filePath)}`;
  });
  return {
    digest: hashBytes(`${entries.join("\n")}\n`),
    entries,
  };
}

export function buildManifestPath(repoRoot) {
  return join(repoRoot, "apps", "server", "dist", ".agent-farm-build.json");
}

export function writeBuildManifest(repoRoot) {
  const serverEntry = join(repoRoot, "apps", "server", "dist", "main.js");
  const webIndex = join(repoRoot, "apps", "web", "dist", "index.html");
  if (!existsSync(serverEntry) || !existsSync(webIndex)) {
    throw new Error("Build outputs are incomplete; expected apps/server/dist/main.js and apps/web/dist/index.html.");
  }
  const { digest, entries } = sourceDigest(repoRoot);
  const manifest = {
    schemaVersion: BUILD_MANIFEST_VERSION,
    sourceDigest: digest,
    sourceEntries: entries,
    outputs: {
      serverEntry: sha256File(serverEntry),
      webIndex: sha256File(webIndex),
    },
  };
  const manifestPath = buildManifestPath(repoRoot);
  mkdirSync(dirname(manifestPath), { recursive: true, mode: 0o755 });
  const temporaryPath = `${manifestPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, manifestPath);
  return { manifestPath, manifest };
}

export function readBuildManifest(repoRoot) {
  const manifestPath = buildManifestPath(repoRoot);
  if (!existsSync(manifestPath)) throw new Error("Build manifest is missing; run pnpm build before starting local mode.");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    throw new Error("Build manifest is unreadable; run pnpm build before starting local mode.");
  }
  if (manifest?.schemaVersion !== BUILD_MANIFEST_VERSION || typeof manifest.sourceDigest !== "string" || typeof manifest.outputs?.serverEntry !== "string" || typeof manifest.outputs?.webIndex !== "string") {
    throw new Error("Build manifest is malformed; run pnpm build before starting local mode.");
  }
  return { manifestPath, manifest };
}

export function assertBuildManifestFresh(repoRoot) {
  const { manifest } = readBuildManifest(repoRoot);
  const current = sourceDigest(repoRoot);
  if (manifest.sourceDigest !== current.digest) throw new Error("Build manifest source digest is stale; run pnpm build before starting local mode.");
  const serverEntry = join(repoRoot, "apps", "server", "dist", "main.js");
  const webIndex = join(repoRoot, "apps", "web", "dist", "index.html");
  if (!existsSync(serverEntry) || !existsSync(webIndex) || manifest.outputs.serverEntry !== sha256File(serverEntry) || manifest.outputs.webIndex !== sha256File(webIndex)) {
    throw new Error("Build outputs do not match the build manifest; run pnpm build before starting local mode.");
  }
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
  try {
    const result = writeBuildManifest(repoRoot);
    console.log(`Build manifest written: ${result.manifestPath}`);
    console.log(`Source digest: ${result.manifest.sourceDigest}`);
  } catch (error) {
    console.error(`Cannot write build manifest: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
