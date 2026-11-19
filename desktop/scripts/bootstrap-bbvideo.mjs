#!/usr/bin/env node
// First-launch bootstrap for the self-contained bb-video environment.
// Invoked by src/server-supervisor.ts (synchronously, before spawning the
// Paperclip server); failures must only be logged, never block startup.
//
//   node scripts/bootstrap-bbvideo.mjs --resources <resourcesRoot> --user-data <userDataRoot>
//
// Layout it establishes under <userData>/bbvideo (stable across app updates,
// unlike the versioned Resources path):
//   toolchain/     copy of <resources>/bbvideo/toolchain (skipped when the
//                  staged toolchain-version.txt digest matches the stamp)
//   bin/ffmpeg     copy of <resources>/bbvideo/bin/ffmpeg, when present
//   output/        render output target

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const STEP = "bootstrap-bbvideo";

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? path.resolve(process.argv[index + 1]) : null;
}

const resourcesRoot = arg("resources");
const userDataRoot = arg("user-data");
if (!resourcesRoot || !userDataRoot) {
  console.error(`[${STEP}] --resources and --user-data are required`);
  process.exit(1);
}

const sourceRoot = path.join(resourcesRoot, "bbvideo");
const home = path.join(userDataRoot, "bbvideo");

try {
  mkdirSync(home, { recursive: true });
  mkdirSync(path.join(home, "output"), { recursive: true });
  mkdirSync(path.join(home, "bin"), { recursive: true });

  const stagedVersionFile = path.join(sourceRoot, "toolchain-version.txt");
  if (!existsSync(stagedVersionFile)) {
    console.error(`[${STEP}] no staged toolchain at ${sourceRoot} — nothing to bootstrap`);
    process.exit(0);
  }
  const stagedVersion = readFileSync(stagedVersionFile, "utf8").trim();
  const stampFile = path.join(home, "toolchain.stamp");

  if (existsSync(stampFile) && readFileSync(stampFile, "utf8").trim() === stagedVersion) {
    // Already bootstrapped for this build; still refresh ffmpeg if missing.
  } else {
    const target = path.join(home, "toolchain");
    rmSync(target, { recursive: true, force: true });
    cpSync(path.join(sourceRoot, "toolchain"), target, { recursive: true });
    writeFileSync(stampFile, `${stagedVersion}\n`, "utf8");
    console.error(`[${STEP}] toolchain copied to ${target} (version ${stagedVersion.slice(0, 12)}…)`);
  }

  const stagedFfmpeg = path.join(sourceRoot, "bin", "ffmpeg");
  if (existsSync(stagedFfmpeg)) {
    const target = path.join(home, "bin", "ffmpeg");
    const needCopy =
      !existsSync(target) ||
      statSync(target).size !== statSync(stagedFfmpeg).size ||
      createHash("sha256").update(readFileSync(target)).digest("hex") !==
        createHash("sha256").update(readFileSync(stagedFfmpeg)).digest("hex");
    if (needCopy) {
      cpSync(stagedFfmpeg, target);
      console.error(`[${STEP}] ffmpeg copied to ${target}`);
    }
  }
  process.exit(0);
} catch (error) {
  console.error(`[${STEP}] failed (non-fatal): ${error?.stack ?? error}`);
  process.exit(0);
}
