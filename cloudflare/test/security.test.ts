import { describe, expect, it } from "vitest";
import { createUserSessionToken, readUserSessionToken } from "../src/security";

const secret = "0123456789abcdef0123456789abcdef";
const principal = {
  id: "usr_test",
  firstName: "Eddy",
  lastName: "SAPIN",
  displayName: "Eddy SAPIN",
  position: "Administrateur",
  role: "ADMIN" as const,
  source: "d1" as const,
  sessionVersion: "session-version-0123456789abcdef",
  access: { suivi_des_stagiaires: true },
};

describe("sessions signées", () => {
  it("accepte un jeton valide et refuse un jeton altéré", async () => {
    const token = await createUserSessionToken(principal, "", secret, 1_000);
    const session = await readUserSessionToken(token, secret, 1_001);
    expect(session?.principal.id).toBe(principal.id);
    const [payload, signature] = token.split(".");
    expect(await readUserSessionToken(`${payload?.slice(0, -1)}A.${signature}`, secret, 1_001)).toBeNull();
  });

  it("refuse un jeton expiré", async () => {
    const token = await createUserSessionToken(principal, "", secret, 1_000);
    expect(await readUserSessionToken(token, secret, 1_000 + 8 * 60 * 60)).toBeNull();
  });
});
