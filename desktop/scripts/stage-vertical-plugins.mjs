#!/usr/bin/env node
// Stage the first-party vertical plugins into the desktop bundled-plugins
// root consumed by the Paperclip server's bundled auto-install path.
//
// Input : <repo>/.stage-plugins/<package>/  (prebuilt: package.json + dist/)
// Output: desktop/resources/bundled-plugins/distribution/<key>/ + catalog.json
//
// The catalog mirrors the server's distribution-plugin-catalog schema
// (schemaVersion 1) and its digest algorithm: a deterministic walk over the
// bundle producing `sha256:<hex>` over the JSON inventory of
// [relativePath, fileSha256, mode] triples. The server recomputes and
// compares the digest before importing anything from the bundle.
//
// Standalone by design:
//   node scripts/stage-vertical-plugins.mjs [--in <dir>] [--out <dir>]
// Defaults resolve against this checkout so `npm run build` can call it too.

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { desktopRoot, log } from "./lib.mjs";

const STEP = "stage-vertical-plugins";

// Plugin keys are the manifest ids (dist/manifest.js `id`) — for this fleet
// they equal the staged package directory names. Keep in sync with
// DESKTOP_AUTO_INSTALL_KEYS in src/server-supervisor.ts.
const PLUGIN_KEYS = [
  "beacon",
  "tradewind",
  "tradewind.bilibili",
  "tradewind.channels",
  "tradewind.douyin",
  "tradewind.wechat",
  "walker",
  "walker.opskeeper",
];

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? path.resolve(process.argv[index + 1]) : null;
}

const inputDir = arg("in") ?? process.env.PAPERCLIP_VERTICAL_PLUGINS_DIR
  ?? path.resolve(desktopRoot, "..", "..", ".stage-plugins");
const outputDir = arg("out") ?? path.join(desktopRoot, "resources", "bundled-plugins");

// Keep the output root present even when skipping, so electron-builder's
// extraResources entry always finds a directory.
mkdirSync(outputDir, { recursive: true });
if (!existsSync(inputDir)) {
  log(STEP, `input ${inputDir} not found — skipping (stage plugins into <repo>/.stage-plugins first)`);
  process.exit(0);
}

/** Same deterministic digest as the server's distributionBundleDigest. */
function bundleDigest(root) {
  const inventory = [];
  const hash = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
  function walk(directory, relative = "") {
    if (relative.split("/").length > 32) throw new Error("bundle exceeds directory depth limit");
    for (const name of readdirSync(directory).sort()) {
      const relativePath = relative ? `${relative}/${name}` : name;
      const file = path.join(directory, name);
      const info = statSync(file);
      if (info.isDirectory()) walk(file, relativePath);
      else if (info.isFile()) inventory.push([relativePath, hash(readFileSync(file)), info.mode & 0o777]);
      else throw new Error(`unexpected non-regular file in bundle: ${relativePath}`);
    }
  }
  walk(root);
  if (!inventory.length) throw new Error(`bundle is empty: ${root}`);
  return hash(JSON.stringify(inventory));
}

const distributionDir = path.join(outputDir, "distribution");
rmSync(distributionDir, { recursive: true, force: true });
mkdirSync(distributionDir, { recursive: true });

const plugins = [];
for (const key of PLUGIN_KEYS) {
  const source = path.join(inputDir, key);
  const pkgFile = path.join(source, "package.json");
  if (!existsSync(pkgFile)) throw new Error(`${STEP}: missing ${pkgFile} (key ${key})`);
  let pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
  if (!pkg.paperclipPlugin) throw new Error(`${STEP}: ${pkgFile} has no paperclipPlugin entrypoints`);
  for (const entry of ["dist/manifest.js", "dist/worker.js"]) {
    if (!existsSync(path.join(source, entry))) throw new Error(`${STEP}: ${key} is not prebuilt (missing ${entry})`);
  }
  const target = path.join(distributionDir, key);
  mkdirSync(target, { recursive: true });
  // The server's distribution catalog requires package.json, catalog entry
  // and dist manifest to agree on version. Treat the built manifest as the
  // source of truth: when package.json lags behind, normalize the STAGED
  // copy (input tree stays untouched) so the bundle verifies end-to-end.
  const manifest = (await import(`file://${path.join(source, "dist", "manifest.js")}`)).default;
  if (manifest.id !== key) throw new Error(`${STEP}: manifest id "${manifest.id}" does not match catalog key "${key}"`);
  let version = pkg.version;
  if (pkg.version !== manifest.version) {
    log(STEP, `warning: ${key} package.json ${pkg.version} != built manifest ${manifest.version}; normalizing staged copy to ${manifest.version}`);
    version = manifest.version;
    pkg = { ...pkg, version };
  }
  writeFileSync(path.join(target, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  cpSync(path.join(source, "dist"), path.join(target, "dist"), { recursive: true });
  plugins.push({
    key,
    pluginKey: key,
    version: pkg.version,
    directory: key,
    digest: bundleDigest(target),
  });
  log(STEP, `staged ${key}@${pkg.version} (digest ${plugins.at(-1).digest.slice(0, 19)}…)`);
}

writeFileSync(
  path.join(distributionDir, "catalog.json"),
  `${JSON.stringify({ schemaVersion: 1, plugins }, null, 2)}\n`,
  "utf8",
);
log(STEP, `catalog with ${plugins.length} plugins -> ${path.join(distributionDir, "catalog.json")}`);

// Plugin workers externalize heavyweight runtime deps (e.g. playwright) and
// expect them to resolve from node_modules. In the packaged layout the
// distribution root sits next to the bundled server tree, which already
// carries those deps — expose it through a relative symlink so Node's
// upward module resolution finds them without duplicating ~1GB.
const sharedNodeModules = path.join(distributionDir, "node_modules");
const symlinkTarget = "../../server/node_modules";
if (!existsSync(sharedNodeModules)) {
  rmSync(sharedNodeModules, { recursive: true, force: true });
  symlinkSync(symlinkTarget, sharedNodeModules);
  log(STEP, `linked ${sharedNodeModules} -> ${symlinkTarget}`);
}
