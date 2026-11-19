#!/usr/bin/env node
// Stage the bb-video toolchain (skill text only) and the ffmpeg bin slot into
// desktop/resources/bbvideo, which electron-builder ships as extraResources.
//
// Input : <paperclip repo>/skills/bb-video  (text: SKILL.md, core/, styles/,
//         explainer/, promo/ — videos/ (sample renders) and .venv/ (rebuild
//         via `pip install edge-tts`) are intentionally excluded)
// Output: desktop/resources/bbvideo/toolchain/**  + bin/README.md
//
// ffmpeg itself is NOT downloaded here: place a static binary at
// desktop/resources/bbvideo/bin/ffmpeg before packaging (see bin/README.md).
// Idempotent; `--out <dir>` overrides the output root.

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { desktopRoot, log, resolvePaperclipRepo } from "./lib.mjs";

const STEP = "stage-bbvideo-env";
const EXCLUDED_TOP = new Set(["videos", ".venv", ".DS_Store"]);

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? path.resolve(process.argv[index + 1]) : null;
}

// Toolchain source order:
//   1. --in <dir>                      (explicit override, e.g. CI checkout)
//   2. ~/.claude/skills/bb-video       (the host skill: core/styles/explainer/
//      promo script trees; videos/ sample renders and .venv/ are excluded)
//   3. <paperclip repo>/skills/bb-video (fallback: SKILL.md + references only)
// The SKILL.md itself is ALWAYS taken from the paperclip repo copy (the
// env-driven BB_VIDEO_HOME/BB_VIDEO_PYTHON variant), which is the single
// source of truth for the skill text.
const paperclipSkillDir = path.join(resolvePaperclipRepo(), "skills", "bb-video");
const hostSkillDir = path.join(os.homedir(), ".claude", "skills", "bb-video");
const sourceDir =
  arg("in") ??
  (existsSync(path.join(hostSkillDir, "promo", "scripts")) ? hostSkillDir : paperclipSkillDir);
const outputDir = arg("out") ?? path.join(desktopRoot, "resources", "bbvideo");

if (!existsSync(path.join(sourceDir, "SKILL.md"))) {
  log(STEP, `${sourceDir} has no SKILL.md — skipping`);
  process.exit(0);
}
if (!existsSync(path.join(paperclipSkillDir, "SKILL.md"))) {
  throw new Error(`${STEP}: paperclip repo skill copy missing: ${paperclipSkillDir}/SKILL.md`);
}

mkdirSync(outputDir, { recursive: true });
const toolchainDir = path.join(outputDir, "toolchain");
rmSync(toolchainDir, { recursive: true, force: true });
mkdirSync(toolchainDir, { recursive: true });

let files = 0;
let bytes = 0;
function copyTree(from, to, relative = "") {
  for (const name of readdirSync(from).sort()) {
    const relativePath = relative ? `${relative}/${name}` : name;
    const src = path.join(from, name);
    const info = statSync(src);
    if (info.isDirectory()) {
      if (relative === "" && EXCLUDED_TOP.has(name)) continue;
      mkdirSync(path.join(to, name));
      copyTree(src, path.join(to, name), relativePath);
    } else if (info.isFile()) {
      cpSync(src, path.join(to, name));
      files += 1;
      bytes += info.size;
    }
  }
}
copyTree(sourceDir, toolchainDir);
// The skill text comes from the paperclip repo (env-driven paths), never from
// the host copy which may still carry machine-specific defaults.
cpSync(path.join(paperclipSkillDir, "SKILL.md"), path.join(toolchainDir, "SKILL.md"));

// Version stamp: content digest of the staged tree, compared by the runtime
// bootstrap (scripts/bootstrap-bbvideo.mjs) to skip redundant copies.
const inventory = [];
function walk(directory, relative = "") {
  for (const name of readdirSync(directory).sort()) {
    const relativePath = relative ? `${relative}/${name}` : name;
    const file = path.join(directory, name);
    const info = statSync(file);
    if (info.isDirectory()) walk(file, relativePath);
    else inventory.push(`${relativePath}:${createHash("sha256").update(readFileSync(file)).digest("hex")}`);
  }
}
walk(toolchainDir);
const version = createHash("sha256").update(JSON.stringify(inventory)).digest("hex");
writeFileSync(path.join(outputDir, "toolchain-version.txt"), `${version}\n`, "utf8");

// ffmpeg slot: keep the README, warn when the binary is absent.
const binDir = path.join(outputDir, "bin");
mkdirSync(binDir, { recursive: true });
if (!existsSync(path.join(binDir, "README.md"))) {
  writeFileSync(
    path.join(binDir, "README.md"),
    [
      "# ffmpeg slot",
      "",
      "Place a static ffmpeg binary here (name it exactly `ffmpeg`, keep the exec bit)",
      "before packaging. It is copied to <userData>/bbvideo/bin on first launch and",
      "prepended to the server PATH so bb-video render scripts find it.",
      "",
      "macOS arm64 static builds: https://evermeet.cx/ffmpeg/ or osxexperts.net.",
      "",
    ].join("\n"),
    "utf8",
  );
}
if (!existsSync(path.join(binDir, "ffmpeg"))) {
  log(STEP, `WARN: no ffmpeg at ${path.join(binDir, "ffmpeg")} — bb-video rendering will rely on a system ffmpeg until one is placed there`);
} else {
  log(STEP, `ffmpeg staged (${statSync(path.join(binDir, "ffmpeg")).size} bytes)`);
}

log(STEP, `toolchain: ${files} files, ${(bytes / 1e6).toFixed(1)} MB -> ${toolchainDir} (version ${version.slice(0, 12)}…)`);
