#!/usr/bin/env node

/**
 * Turn the normal Vite output into the self-contained HTML served for
 * `ui://agent-farm/hierarchy.html`.
 *
 * The MCP Apps host can only fetch the resource returned by the MCP server;
 * it must not need to resolve a second `/assets/*` URL.  This script therefore
 * reads the deterministic Vite HTML, inlines its local CSS and JavaScript,
 * and writes a separate resource artifact without changing the standalone
 * entrypoint.  It deliberately rejects remote or path-traversing assets.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const webDirectory = resolve(scriptDirectory, '..');
const distDirectory = resolve(webDirectory, 'dist');
const sourceHtmlPath = resolve(distDirectory, 'index.html');
const resourceHtmlPath = resolve(distDirectory, 'mcp-resource.html');
const resourceManifestPath = resolve(distDirectory, 'mcp-resource.json');
const resourceUri = 'ui://agent-farm/hierarchy.html';

const sourceHtml = await readFile(sourceHtmlPath, 'utf8');
const assetPattern = /(?:href|src)=["']([^"']+)["']/giu;
const assets = [...sourceHtml.matchAll(assetPattern)]
  .map((match) => match[1])
  .filter((value) => value !== undefined)
  .filter((value) => value.startsWith('./') || value.startsWith('/'));

let resourceHtml = sourceHtml;
for (const asset of assets) {
  const localAssetPath = resolveAssetPath(asset);
  const assetContents = await readFile(localAssetPath, 'utf8');
  if (isStylesheetReference(resourceHtml, asset)) {
    resourceHtml = replaceOnce(
      resourceHtml,
      new RegExp(`<link\\s+([^>]*?)(?:href)=["']${escapeRegExp(asset)}["']([^>]*)>`, 'iu'),
      '<style data-agent-farm-asset="inline">\n$CONTENT\n</style>',
      assetContents,
    );
  } else if (isModuleScriptReference(resourceHtml, asset)) {
    resourceHtml = replaceOnce(
      resourceHtml,
      new RegExp(`<script\\s+([^>]*?)(?:src)=["']${escapeRegExp(asset)}["']([^>]*)></script>`, 'iu'),
      '<script type="module" data-agent-farm-asset="inline">\n$CONTENT\n</script>',
      assetContents,
    );
  }
}

if (/(?:src|href)=["'](?:\.?\/|\/)?assets\//iu.test(resourceHtml)) {
  throw new Error('MCP resource still references an external Vite asset');
}
if (/\bfrom["'][^"'.\/]/u.test(resourceHtml)) {
  throw new Error('MCP resource contains an unbundled bare module import');
}
resourceHtml = addResourceMetadata(resourceHtml);
const normalizedHtml = `${resourceHtml.trim()}\n`;
const digest = createHash('sha256').update(normalizedHtml, 'utf8').digest('hex');
const manifest = `${JSON.stringify({
  resourceUri,
  mimeType: 'text/html;profile=mcp-app',
  entrypoint: 'mcp-resource.html',
  inline: true,
  sha256: digest,
  bytes: Buffer.byteLength(normalizedHtml, 'utf8'),
}, null, 2)}\n`;

await writeFile(resourceHtmlPath, normalizedHtml, 'utf8');
await writeFile(resourceManifestPath, manifest, 'utf8');

console.log(`Wrote ${resourceHtmlPath}`);
console.log(`Wrote ${resourceManifestPath}`);
console.log(`MCP resource sha256: ${digest}`);

function resolveAssetPath(asset) {
  if (/^[a-z][a-z\d+.-]*:/iu.test(asset) || asset.startsWith('//')) {
    throw new Error(`Remote MCP resource asset is not allowed: ${asset}`);
  }
  const relativeAsset = asset.startsWith('/') ? asset.slice(1) : asset.slice(2);
  const candidate = resolve(distDirectory, relativeAsset);
  const relativeToDist = relative(distDirectory, candidate);
  if (relativeToDist.startsWith('..') || isAbsolute(relativeToDist)) {
    throw new Error(`MCP resource asset escapes dist/: ${asset}`);
  }
  return candidate;
}

function isStylesheetReference(html, asset) {
  return new RegExp(`<link\\s+[^>]*?href=["']${escapeRegExp(asset)}["']`, 'iu').test(html);
}

function isModuleScriptReference(html, asset) {
  return new RegExp(`<script\\s+[^>]*?src=["']${escapeRegExp(asset)}["']`, 'iu').test(html);
}

function replaceOnce(value, pattern, replacement, content) {
  let matched = false;
  const next = value.replace(pattern, (_match, first = '', second = '') => {
    matched = true;
    return replacement
      .replaceAll('$1', String(first))
      .replaceAll('$2', String(second))
      .replace('$CONTENT', () => content);
  });
  if (!matched) throw new Error(`Unable to inline Vite asset using ${pattern}`);
  return next;
}

function escapeRegExp(value) {
  const regexCharacters = new Set(['\\\\', '^', '$', '.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|', '/']);
  return [...value].map((character) => regexCharacters.has(character) ? `\\${character}` : character).join('');
}

function addResourceMetadata(html) {
  const marker = '<meta name="agent-farm-resource" content="ui://agent-farm/hierarchy.html">';
  if (html.includes('name="agent-farm-resource"')) return html;
  return html.replace(/<head([^>]*)>/iu, `<head$1>\n    ${marker}`);
}
