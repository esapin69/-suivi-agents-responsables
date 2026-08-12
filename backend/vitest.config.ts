import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)) },
      miniflare: {
        d1Databases: ["FRESH_DB"],
        bindings: {
          SESSION_SECRET: "0123456789abcdef0123456789abcdef-test",
          BOOTSTRAP_TOKEN: "bootstrap-0123456789abcdef0123456789abcdef",
          TEST_MIGRATIONS: await readD1Migrations(path.join(fileURLToPath(new URL(".", import.meta.url)), "migrations")),
        },
      },
    })),
  ],
  test: {
    include: ["backend/test/**/*.test.ts"],
    setupFiles: [fileURLToPath(new URL("./test/apply-migrations.ts", import.meta.url))],
    sequence: { concurrent: false },
  },
});
