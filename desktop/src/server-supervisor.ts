import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, type WriteStream } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serverEntry, serverRoot, dataHome, logsDir, serverLogFile, serverBundledPluginsRoot, bbvideoResourcesRoot, bbvideoHome } from "./paths.js";
import { resolveUserPath } from "./user-path.js";
import { ENTRY_ENV, SHIM_ENV, writeNodeShim } from "./node-shim.js";

/**
 * Auto-install keys for the first-party vertical plugins bundled with the
 * desktop build. Each key maps to a bundle under
 * <bundled root>/distribution/ declared in catalog.json (staged by
 * scripts/stage-vertical-plugins.mjs); keys and catalog entries must stay
 * in sync.
 */
export const DESKTOP_AUTO_INSTALL_KEYS = [
  "bb-video",
  "beacon",
  "tradewind",
  "tradewind.bilibili",
  "tradewind.channels",
  "tradewind.douyin",
  "tradewind.wechat",
  "walker",
  "walker.opskeeper",
] as const;

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** The bundled bootstrap that loads the server with a Node-compatible execPath. */
export function serverBootstrapEntry(): string {
  return path.join(moduleDir, "server-bootstrap.cjs");
}

export interface SupervisorOptions {
  /** Fixed port. Default 0 -> let the server pick (detect-port) and report it. */
  port?: number;
  onLog?: (line: string) => void;
  onExit?: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
  /** Reported once the shell PATH has been resolved, before the spawn. */
  onEnvResolved?: (info: { pathSource: string; pathEntries: number }) => void;
}

export interface StartedServer {
  port: number;
  baseUrl: string;
  stop: () => Promise<void>;
}

const HEALTH_TIMEOUT_MS = Number(process.env.PAPERCLIP_DESKTOP_HEALTH_TIMEOUT_MS ?? 240_000);
const SHUTDOWN_TIMEOUT_MS = 15_000;
const DEFAULT_PORT = Number(process.env.PAPERCLIP_DESKTOP_PORT ?? 3187);

/**
 * Run scripts/bootstrap-bbvideo.mjs (userData copy of the bundled toolchain
 * and ffmpeg) before the server starts. Failures are logged only.
 */
function bootstrapBbvideo(env: NodeJS.ProcessEnv, standaloneNode: string | undefined): void {
  // build.mjs copies scripts/bootstrap-bbvideo.mjs into dist/, so this
  // resolves both in dev (dist bundle) and in the packaged app.
  const script = path.join(moduleDir, "bootstrap-bbvideo.mjs");
  if (!existsSync(script)) return; // layout without the script: skip silently
  try {
    const childEnv: NodeJS.ProcessEnv = { ...env };
    if (!standaloneNode) childEnv.ELECTRON_RUN_AS_NODE = "1";
    else delete childEnv.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(process.execPath, [script, "--resources", path.dirname(bbvideoResourcesRoot()), "--user-data", path.dirname(bbvideoHome())], {
      encoding: "utf8",
      env: childEnv,
    });
    if (result.status !== 0) {
      console.error(`[bbvideo] bootstrap exited ${result.status}: ${result.stderr ?? ""}`);
    }
  } catch (error) {
    console.error(`[bbvideo] bootstrap failed (non-fatal): ${error}`);
  }
}

function serverEnv(port: number, userPath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // A Finder-launched app gets a minimal PATH, which hides user-installed
    // agent CLIs (claude, codex, ...) from the server's command resolution.
    PATH: userPath,
    // Never inherit a developer's own Paperclip home / instance.
    PAPERCLIP_HOME: dataHome(),
    PAPERCLIP_INSTANCE_ID: "desktop",
    PAPERCLIP_MIGRATION_PROMPT: "never",
    PAPERCLIP_MIGRATION_AUTO_APPLY: "true",
    // Authenticated mode: assistant connections (MCP) require real user
    // accounts; better-auth only initializes outside local_trusted.
    PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
    PAPERCLIP_BIND: "loopback",
    PAPERCLIP_OPEN_ON_LISTEN: "false",
    NODE_ENV: "production",
    PORT: String(port),
    // Assistant connections (public MCP): loopback-only origin derived from the
    // actual listen port so OAuth issuer/resource stay consistent.
    PAPERCLIP_PUBLIC_URL: `http://127.0.0.1:${port}`,
    // Electron's Node exposes electron-specific version keys; the server only
    // cares about process.versions.node, which is Electron's bundled Node.
    ELECTRON_RUN_AS_NODE: undefined as unknown as string,
  };
}

export async function startServer(options: SupervisorOptions = {}): Promise<StartedServer> {
  const port = options.port ?? DEFAULT_PORT;
  mkdirSync(logsDir(), { recursive: true });
  const logStream: WriteStream = createWriteStream(serverLogFile(), { flags: "a" });

  const standaloneNode = process.env.PAPERCLIP_DESKTOP_NODE_BIN?.trim();
  const command = standaloneNode || process.execPath;
  const userPath = resolveUserPath();
  options.onEnvResolved?.({
    pathSource: userPath.source,
    pathEntries: userPath.value.split(":").filter(Boolean).length,
  });
  const env = serverEnv(port, userPath.value);
  // Authenticated mode requires BETTER_AUTH_SECRET; persist one per instance
  // (dataHome survives restarts) instead of baking a secret into the repo.
  const secretPath = path.join(dataHome(), "auth-secret.key");
  if (!existsSync(secretPath)) {
    mkdirSync(path.dirname(secretPath), { recursive: true });
    writeFileSync(secretPath, randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
  }
  env.BETTER_AUTH_SECRET = readFileSync(secretPath, "utf8").trim();
  if (standaloneNode) delete env.ELECTRON_RUN_AS_NODE;
  else env.ELECTRON_RUN_AS_NODE = "1";

  // The server spawns its own children with `process.execPath`, and the agent
  // directory probe does so with an EMPTY environment. Under Electron that
  // drops ELECTRON_RUN_AS_NODE and the child dies with "Unable to find
  // Electron app at ...". The bootstrap points the server's process.execPath at
  // a shim that re-exports the runtime as Node regardless of the environment.
  const entry = serverEntry();
  env[ENTRY_ENV] = entry;

  // First-party vertical plugins: point the server at the bundled root and
  // extend the self-hosted auto-install list. The server refuses to start on
  // auto-install keys that resolve to no bundle, so only inject when the
  // staged distribution catalog is actually present (dev builds without a
  // plugin stage keep the stock kubernetes-only behavior).
  const bundledRoot = serverBundledPluginsRoot();
  const catalogFile = path.join(bundledRoot, "distribution", "catalog.json");
  if (existsSync(catalogFile)) {
    env.PAPERCLIP_BUNDLED_PLUGIN_ROOT = bundledRoot;
    // Profile builds bundle only a subset (BB_PROFILE in
    // stage-vertical-plugins.mjs): the server refuses to start on auto-install
    // keys with no bundle, so intersect the key list with the actual catalog.
    let catalogKeys: readonly string[] = [];
    try {
      const catalog = JSON.parse(readFileSync(catalogFile, "utf8"));
      catalogKeys = Array.isArray(catalog.plugins) ? catalog.plugins.map((entry: { key?: string }) => entry.key).filter(Boolean) : [];
    } catch {
      catalogKeys = [];
    }
    const keys = catalogKeys.length > 0
      ? DESKTOP_AUTO_INSTALL_KEYS.filter((key) => catalogKeys.includes(key))
      : [...DESKTOP_AUTO_INSTALL_KEYS];
    if (keys.length > 0) env.PAPERCLIP_DESKTOP_AUTO_INSTALL_KEYS = keys.join(",");
  }
  if (!standaloneNode) {
    const shim = writeNodeShim(
      path.join(dataHome(), "bin", "paperclip-node"),
      process.execPath,
    );
    env[SHIM_ENV] = shim;
  }

  // Self-contained bb-video environment: bootstrap the userData copy of the
  // bundled toolchain/ffmpeg BEFORE the server spawns (synchronous; a failure
  // is logged and must not block startup), then expose the stable paths and
  // prepend the bin dir so bare `ffmpeg` resolves to the bundled binary.
  bootstrapBbvideo(env, standaloneNode);
  const bbBin = path.join(bbvideoHome(), "bin");
  env.BB_VIDEO_HOME = path.join(bbvideoHome(), "toolchain");
  env.BB_VIDEO_PYTHON ??= "python3";
  env.PATH = [bbBin, env.PATH].filter(Boolean).join(":");

  const child: ChildProcess = spawn(command, [serverBootstrapEntry()], {
    cwd: serverRoot(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let resolvedPort = port;
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;

  const forward = (chunk: Buffer) => {
    const text = chunk.toString();
    logStream.write(text);
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      options.onLog?.(line);
      const match = line.match(/https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)/);
      if (match) resolvedPort = Number(match[1]);
    }
  };
  child.stdout?.on("data", forward);
  child.stderr?.on("data", forward);
  child.on("exit", (code, signal) => {
    exited = { code, signal };
    logStream.end();
    options.onExit?.({ code, signal });
  });

  const stop = async (): Promise<void> => {
    if (exited || child.killed) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, SHUTDOWN_TIMEOUT_MS);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  };

  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    if (exited) {
      await stop();
      throw new Error(
        `Paperclip server exited before becoming healthy (code=${exited.code} signal=${exited.signal}). ` +
          `See ${serverLogFile()}`,
      );
    }
    try {
      const response = await fetch(`http://127.0.0.1:${resolvedPort}/api/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) {
        return { port: resolvedPort, baseUrl: `http://127.0.0.1:${resolvedPort}`, stop };
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  await stop();
  throw new Error(
    `Paperclip server did not become healthy within ${HEALTH_TIMEOUT_MS}ms` +
      `${lastError ? ` (${(lastError as Error).message})` : ""}. See ${serverLogFile()}`,
  );
}
