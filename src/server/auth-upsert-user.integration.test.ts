import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { schema } from "@/server/db";
import { setupTestDb, testDb } from "@/test/pglite-db";

// next-auth cannot be resolved under vitest's node env; upsertUser does not use it.
vi.mock("next-auth", () => ({ default: () => ({ handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }) }));
vi.mock("next-auth/providers/google", () => ({ default: vi.fn() }));
vi.mock("next-auth/providers/credentials", () => ({ default: vi.fn() }));
vi.mock("@/server/db", async () => (await import("@/test/pglite-db")).dbModuleMock());

import { upsertUser } from "./auth";

setupTestDb();

async function storedScopes(id: string) {
  const [row] = await testDb.select({ s: schema.users.googleScopes }).from(schema.users).where(eq(schema.users.id, id));
  return row.s;
}

describe("upsertUser googleScopes", () => {
  it("stores on insert, ignores undefined on update, overwrites with a string", async () => {
    const base = { name: "Sc", email: "scopes@example.com" };
    const created = await upsertUser({ ...base, googleScopes: "openid a" });
    expect(await storedScopes(created.id)).toBe("openid a");

    await upsertUser({ ...base, googleScopes: undefined });
    expect(await storedScopes(created.id)).toBe("openid a");

    await upsertUser({ ...base, googleScopes: "openid b" });
    expect(await storedScopes(created.id)).toBe("openid b");
  });
});
