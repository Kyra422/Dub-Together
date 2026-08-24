import vinext from "vinext";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json";
import { sites } from "./build/sites-vite-plugin";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

// Production Cloudflare resources are injected by Workers Builds so account-
// specific IDs do not need to be committed to this public repository.
const productionDatabaseId = process.env.DUB_TOGETHER_D1_DATABASE_ID?.trim();
const productionDatabaseName =
  process.env.DUB_TOGETHER_D1_DATABASE_NAME?.trim() || "dub-together-db";
const productionR2BucketName = process.env.DUB_TOGETHER_R2_BUCKET_NAME?.trim();
const isWorkersBuild = process.env.WORKERS_CI === "1";

if (isWorkersBuild && d1 && !productionDatabaseId) {
  throw new Error(
    "Missing DUB_TOGETHER_D1_DATABASE_ID in Cloudflare Workers build environment variables.",
  );
}
if (isWorkersBuild && r2 && !productionR2BucketName) {
  throw new Error(
    "Missing DUB_TOGETHER_R2_BUCKET_NAME in Cloudflare Workers build environment variables.",
  );
}

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: productionDatabaseId
            ? productionDatabaseName
            : "site-creator-d1",
          database_id:
            productionDatabaseId || SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: productionR2BucketName || "site-creator-r2",
        },
      ]
    : [],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
