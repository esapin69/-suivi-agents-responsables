import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll } from "vitest";

beforeAll(async () => {
  const testEnv = env as typeof env & { DB: D1Database; TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});
