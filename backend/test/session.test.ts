import { describe, expect, it } from "vitest";
import { createSessionToken, readSessionToken } from "../src/index";

const user = {
  id: "TEST|RESPONSABLE",
  nom: "TEST",
  prenom: "RESPONSABLE",
  poste: "Chef",
  display_name: "RESPONSABLE TEST",
  is_admin: false,
  access_version: "test-session-version-0123456789abcdef",
};

const secret = "0123456789abcdef0123456789abcdef";

describe("signed sessions", () => {
  it("accepts a valid unexpired token", async () => {
    const token = await createSessionToken(user, secret, 1_000);
    const result = await readSessionToken(token, secret, 1_001);
    expect(result?.id).toBe(user.id);
    expect(result?.is_admin).toBe(false);
  });

  it("rejects an expired token", async () => {
    const token = await createSessionToken(user, secret, 1_000);
    const result = await readSessionToken(token, secret, 1_000 + 8 * 60 * 60);
    expect(result).toBeNull();
  });

  it("rejects a modified payload", async () => {
    const token = await createSessionToken(user, secret, 1_000);
    const [payload, signature] = token.split(".");
    const changed = `${payload.slice(0, -1)}A.${signature}`;
    expect(await readSessionToken(changed, secret, 1_001)).toBeNull();
  });
});
