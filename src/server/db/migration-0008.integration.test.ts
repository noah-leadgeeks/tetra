import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMigratedDb } from "@/test/pglite-db";
import { agentActions, apiTokens, users } from "./schema";

type Migrated = Awaited<ReturnType<typeof createMigratedDb>>;

let ctx: Migrated;
let userId: string;
let seq = 0;

/** Drizzle wraps driver errors; the constraint/index name lives in the cause chain. */
async function failureText(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    const parts: string[] = [];
    let e: unknown = err;
    while (e instanceof Error) {
      parts.push(e.message);
      e = (e as Error & { cause?: unknown }).cause;
    }
    return parts.join(" | ");
  }
  throw new Error("expected statement to fail");
}

function token() {
  seq += 1;
  return { userId, name: "t", tokenHash: `hash-${seq}`, tokenPrefix: "tetra_abcdef" };
}

beforeAll(async () => {
  ctx = await createMigratedDb();
  const [u] = await ctx.db
    .insert(users)
    .values({ name: "U", email: "u@example.com", timezone: "UTC" })
    .returning();
  userId = u.id;
}, 60_000);

afterAll(async () => {
  await ctx.client.close();
});

describe("migration 0008 (agent api)", () => {
  it("users.google_scopes is writable and nullable", async () => {
    const [before] = await ctx.db.select().from(users).where(eq(users.id, userId));
    expect(before.googleScopes).toBeNull();
    await ctx.db.update(users).set({ googleScopes: "openid email" }).where(eq(users.id, userId));
    const [after] = await ctx.db.select().from(users).where(eq(users.id, userId));
    expect(after.googleScopes).toBe("openid email");
  });

  it("api_tokens defaults scopes to {read} and enforces unique hash", async () => {
    const [row] = await ctx.db.insert(apiTokens).values(token()).returning();
    expect(row.scopes).toEqual(["read"]);
    expect(row.revokedAt).toBeNull();
    const dup = await failureText(
      ctx.db.insert(apiTokens).values({ ...token(), tokenHash: row.tokenHash }),
    );
    expect(dup).toContain("api_tokens_token_hash_unique");
  });

  it("api_tokens rejects empty scopes", async () => {
    const msg = await failureText(ctx.db.insert(apiTokens).values({ ...token(), scopes: [] }));
    expect(msg).toContain("api_tokens_scopes_nonempty");
  });

  it("agent_actions inserts with default executed status and token set null", async () => {
    const [tok] = await ctx.db.insert(apiTokens).values(token()).returning();
    const [row] = await ctx.db
      .insert(agentActions)
      .values({ userId, tokenId: tok.id, kind: "task.update", targetType: "task", summary: { label: "x" } })
      .returning();
    expect(row.status).toBe("executed");
    await ctx.db.delete(apiTokens).where(eq(apiTokens.id, tok.id));
    const [after] = await ctx.db.select().from(agentActions).where(eq(agentActions.id, row.id));
    expect(after.tokenId).toBeNull();
  });

  it("partial unique index allows one pending per target but many non-pending", async () => {
    const targetId = crypto.randomUUID();
    const base = { userId, kind: "task.delete", targetType: "task", targetId, summary: {} };
    const future = new Date(Date.now() + 3_600_000);
    await ctx.db.insert(agentActions).values({ ...base, status: "pending", expiresAt: future });
    const msg = await failureText(
      ctx.db.insert(agentActions).values({ ...base, status: "pending", expiresAt: future }),
    );
    expect(msg).toContain("agent_actions_pending_target_unique");
    await ctx.db.insert(agentActions).values({ ...base, status: "executed" });
    await ctx.db.insert(agentActions).values({ ...base, status: "executed" });
  });

  it("rejects pending without expires_at", async () => {
    const msg = await failureText(
      ctx.db
        .insert(agentActions)
        .values({ userId, kind: "k", targetType: "task", targetId: crypto.randomUUID(), summary: {}, status: "pending" }),
    );
    expect(msg).toContain("agent_actions_pending_expires");
  });

  it("accepts executing only with claimed_at", async () => {
    const msg = await failureText(
      ctx.db
        .insert(agentActions)
        .values({ userId, kind: "k", targetType: "task", targetId: crypto.randomUUID(), summary: {}, status: "executing" }),
    );
    expect(msg).toContain("agent_actions_executing_claimed");
    const [row] = await ctx.db
      .insert(agentActions)
      .values({
        userId,
        kind: "k",
        targetType: "task",
        targetId: crypto.randomUUID(),
        summary: {},
        status: "executing",
        claimedAt: new Date(),
      })
      .returning();
    expect(row.status).toBe("executing");
  });
});
