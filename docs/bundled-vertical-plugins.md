# Bundled vertical plugins (desktop)

The desktop build pre-installs the first-party vertical plugins (beacon, tradewind + 4 channel subplugins, walker + opskeeper) through the Paperclip server's bundled auto-install mechanism — no HTTP marketplace, no user action.

## Flow

1. Each plugin repo builds into `<PaperPlugins>/.stage-plugins/<package>/` (prebuilt: `package.json` + `dist/`).
2. `desktop/scripts/stage-vertical-plugins.mjs` (called by `npm run build`, also standalone with `--in`/`--out`) copies each package into `desktop/resources/bundled-plugins/distribution/<key>/` and writes `distribution/catalog.json` — schema v1 with a `sha256` digest per bundle, computed with the same deterministic inventory walk as the server's `distributionBundleDigest`. When a package's `package.json` version lags behind its built manifest, the staged copy is normalized to the manifest version (input tree untouched).
3. electron-builder ships `resources/bundled-plugins` as `Contents/Resources/bundled-plugins`.
4. `src/server-supervisor.ts` sets `PAPERCLIP_BUNDLED_PLUGIN_ROOT` and `PAPERCLIP_DESKTOP_AUTO_INSTALL_KEYS` (the 8 keys, kept in sync with the staging script's `PLUGIN_KEYS`) — but only when the staged `distribution/catalog.json` exists, because the server refuses to start on auto-install keys with no resolvable bundle. Dev builds without a staged catalog keep the stock kubernetes-only behavior.
5. The server (patched in the paperclip checkout, branch `desktop-bundled-plugins`) appends those keys to the self-hosted auto-install list, verifies each bundle's digest, then installs/reconciles at boot. New capabilities on an existing install surface as `upgrade_pending`.
