import { eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { schema } from "@/server/db";
import { setupTestDb, testDb } from "@/test/pglite-db";

vi.mock("@/server/db", async () => (await import("@/test/pglite-db")).dbModuleMock());

import { BadRequestError } from "./errors";
import {
  authenticateToken,
  createApiToken,
  generateToken,
  listApiTokens,
  revokeApiToken,
  scopeGrants,
} from "./tokens";

setupTestDb();

async function seedUser(timezone = "Asia/Jakarta") {
  const [u] = await testDb
    .insert(schema.users)
    .values({ name: "T", email: `t-${Math.random()}@example.com`, timezone })
    .returning();
  return u;
}

async function lastUsed(id: string) {
  const [r] = await testDb
    .select({ v: schema.apiTokens.lastUsedAt })
    .from(schema.apiTokens)
    .where(eq(schema.apiTokens.id, id));
  return r.v;
}

describe("generateToken / scopeGrants", () => {
  it("builds a prefixed token with sha256 hash", () => {
    const t = generateToken();
    expect(t.plaintext.startsWith("tetra_")).toBe(true);
    expect(t.prefix).toBe(t.plaintext.slice(0, 12));
    expect(t.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("read is satisfied by any scope; write/delete need themselves", () => {
    expect(scopeGrants(["delete"], "read")).toBe(true);
    expect(scopeGrants(["write"], "read")).toBe(true);
    expect(scopeGrants([], "read")).toBe(false);
    expect(scopeGrants(["read"], "write")).toBe(false);
    expect(scopeGrants(["write"], "delete")).toBe(false);
    expect(scopeGrants(["delete"], "delete")).toBe(true);
  });
});

describe("api tokens", () => {
  it("authenticates a valid token with user, timezone and default read scope", async () => {
    const u = await seedUser("America/New_York");
    const created = await createApiToken(u.id, { name: "agent" });
    expect(created.scopes).toEqual(["read"]);
    expect(created.expiresAt).toBeNull();
    const auth = await authenticateToken(created.token);
    expect(auth).toEqual({
      userId: u.id,
      timezone: "America/New_York",
      tokenId: created.id,
      tokenName: "agent",
      scopes: ["read"],
    });
  });

  it("never stores plaintext and list omits hashes", async () => {
    const u = await seedUser();
    const created = await createApiToken(u.id, { name: "x", scopes: ["read", "write"] });
    const rows = await testDb.select().from(schema.apiTokens);
    expect(JSON.stringify(rows)).not.toContain(created.token);
    const listed = await listApiTokens(u.id);
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain("tokenHash");
    expect(Object.keys(listed[0])).not.toContain("tokenHash");
  });

  it("rejects unknown, malformed and wrong-length tokens", async () => {
    const u = await seedUser();
    await createApiToken(u.id, { name: "x" });
    expect(await authenticateToken(generateToken().plaintext)).toBeNull();
    expect(await authenticateToken("")).toBeNull();
    expect(await authenticateToken("nottetra_abc")).toBeNull();
    expect(await authenticateToken("tetra_")).toBeNull();
    expect(await authenticateToken("tetra_" + "a".repeat(5000))).toBeNull();
  });

  it("rejects revoked and expired tokens", async () => {
    const u = await seedUser();
    const revoked = await createApiToken(u.id, { name: "r" });
    expect(await revokeApiToken(u.id, revoked.id)).toBe(true);
    expect(await authenticateToken(revoked.token)).toBeNull();

    const expired = await createApiToken(u.id, { name: "e", expiresInDays: 1 });
    expect(await authenticateToken(expired.token)).not.toBeNull();
    await testDb
      .update(schema.apiTokens)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(schema.apiTokens.id, expired.id));
    expect(await authenticateToken(expired.token)).toBeNull();
  });

  it("throttles last_used_at updates", async () => {
    const u = await seedUser();
    const t = await createApiToken(u.id, { name: "t" });
    expect(await lastUsed(t.id)).toBeNull();

    await authenticateToken(t.token);
    const first = await lastUsed(t.id);
    expect(first).not.toBeNull();

    await authenticateToken(t.token);
    expect((await lastUsed(t.id))?.getTime()).toBe(first?.getTime());

    await testDb
      .update(schema.apiTokens)
      .set({ lastUsedAt: sql`now() - interval '2 minutes'` })
      .where(eq(schema.apiTokens.id, t.id));
    const stale = await lastUsed(t.id);
    await authenticateToken(t.token);
    const third = await lastUsed(t.id);
    expect(third && stale && third.getTime() > stale.getTime()).toBe(true);
  });

  it("validates scopes, name and expiry", async () => {
    const u = await seedUser();
    await expect(createApiToken(u.id, { name: "x", scopes: [] })).rejects.toThrow();
    await expect(createApiToken(u.id, { name: "x", scopes: ["admin"] })).rejects.toThrow();
    await expect(createApiToken(u.id, { name: "" })).rejects.toThrow();
    await expect(createApiToken(u.id, { name: "a".repeat(81) })).rejects.toBeInstanceOf(BadRequestError);
    await expect(createApiToken(u.id, { name: "x", scopes: ["admin"] })).rejects.toBeInstanceOf(BadRequestError);
    await expect(createApiToken(u.id, { name: "x", expiresInDays: 0 })).rejects.toBeInstanceOf(BadRequestError);
    await expect(createApiToken(u.id, { name: "x", expiresInDays: 0 })).rejects.toThrow();
    await expect(createApiToken(u.id, { name: "x", expiresInDays: 366 })).rejects.toThrow();
    const ok = await createApiToken(u.id, { name: "x", expiresInDays: 30 });
    expect(ok.expiresAt).toBeInstanceOf(Date);
  });

  it("revoking expires the token's pending actions and is idempotent and user-scoped", async () => {
    const u = await seedUser();
    const other = await seedUser();
    const t = await createApiToken(u.id, { name: "t", scopes: ["delete"] });
    const [pending] = await testDb
      .insert(schema.agentActions)
      .values({
        userId: u.id,
        tokenId: t.id,
        kind: "task.delete",
        targetType: "task",
        targetId: crypto.randomUUID(),
        summary: {},
        status: "pending",
        expiresAt: new Date(Date.now() + 3600_000),
      })
      .returning();

    expect(await revokeApiToken(other.id, t.id)).toBe(false);
    expect(await revokeApiToken(u.id, t.id)).toBe(true);
    expect(await revokeApiToken(u.id, t.id)).toBe(true);
    expect(await revokeApiToken(u.id, crypto.randomUUID())).toBe(false);

    const [after] = await testDb
      .select()
      .from(schema.agentActions)
      .where(eq(schema.agentActions.id, pending.id));
    expect(after.status).toBe("expired");
    expect(after.resolvedAt).not.toBeNull();
    expect((after.result as { code: string }).code).toBe("token_revoked");
  });
});
