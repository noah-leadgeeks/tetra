import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import { BadRequestError } from "@/features/agent-api/errors";
import { db } from "@/server/db";
import { agentActions, apiTokens, users } from "@/server/db/schema";

export const AGENT_SCOPES = ["read", "write", "delete"] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];

const TOKEN_PREFIX = "tetra_";

export interface AgentTokenAuth {
  userId: string;
  timezone: string;
  tokenId: string;
  tokenName: string;
  scopes: AgentScope[];
}

export function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

export function generateToken(): { plaintext: string; hash: string; prefix: string } {
  const plaintext = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  return { plaintext, hash: hashToken(plaintext), prefix: plaintext.slice(0, 12) };
}

/** `read` is satisfied by any scope; `write` and `delete` require themselves. */
export function scopeGrants(scopes: readonly string[], required: AgentScope): boolean {
  if (required === "read") return AGENT_SCOPES.some((s) => scopes.includes(s));
  return scopes.includes(required);
}

function isScope(value: string): value is AgentScope {
  return (AGENT_SCOPES as readonly string[]).includes(value);
}

export interface CreateApiTokenInput {
  name: string;
  scopes?: string[];
  expiresInDays?: number;
}

export async function createApiToken(userId: string, input: CreateApiTokenInput) {
  const name = input.name?.trim() ?? "";
  if (name.length < 1 || name.length > 80) {
    throw new BadRequestError("Token name must be 1-80 characters");
  }
  const scopes = input.scopes ?? ["read"];
  if (scopes.length === 0 || !scopes.every(isScope)) {
    throw new BadRequestError(`Scopes must be a non-empty subset of: ${AGENT_SCOPES.join(", ")}`);
  }
  const uniqueScopes = [...new Set(scopes)] as AgentScope[];

  let expiresAt: Date | null = null;
  if (input.expiresInDays !== undefined) {
    const days = input.expiresInDays;
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      throw new BadRequestError("expiresInDays must be an integer between 1 and 365");
    }
    expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }

  const { plaintext, hash, prefix } = generateToken();
  const [row] = await db
    .insert(apiTokens)
    .values({ userId, name, tokenHash: hash, tokenPrefix: prefix, scopes: uniqueScopes, expiresAt })
    .returning();

  return {
    token: plaintext,
    id: row.id,
    name: row.name,
    prefix: row.tokenPrefix,
    scopes: row.scopes as AgentScope[],
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

export async function listApiTokens(userId: string) {
  const rows = await db
    .select({
      id: apiTokens.id,
      name: apiTokens.name,
      prefix: apiTokens.tokenPrefix,
      scopes: apiTokens.scopes,
      expiresAt: apiTokens.expiresAt,
      revokedAt: apiTokens.revokedAt,
      lastUsedAt: apiTokens.lastUsedAt,
      createdAt: apiTokens.createdAt,
    })
    .from(apiTokens)
    .where(eq(apiTokens.userId, userId))
    .orderBy(apiTokens.createdAt);
  return rows.map((r) => ({ ...r, scopes: r.scopes as AgentScope[] }));
}

/** Revokes the token and expires its pending actions. Idempotent; false when not found. */
export async function revokeApiToken(userId: string, id: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: apiTokens.id })
      .from(apiTokens)
      .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, userId)));
    if (!row) return false;

    await tx
      .update(apiTokens)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(apiTokens.id, id), sql`${apiTokens.revokedAt} IS NULL`));
    await tx
      .update(agentActions)
      .set({
        status: "expired",
        resolvedAt: sql`now()`,
        result: { code: "token_revoked" },
      })
      .where(and(eq(agentActions.tokenId, id), eq(agentActions.status, "pending")));
    return true;
  });
}

export async function authenticateToken(plaintext: string): Promise<AgentTokenAuth | null> {
  if (typeof plaintext !== "string" || !plaintext.startsWith(TOKEN_PREFIX)) return null;
  const hash = hashToken(plaintext);

  const [row] = await db
    .select({
      id: apiTokens.id,
      name: apiTokens.name,
      tokenHash: apiTokens.tokenHash,
      scopes: apiTokens.scopes,
      expiresAt: apiTokens.expiresAt,
      revokedAt: apiTokens.revokedAt,
      userId: users.id,
      timezone: users.timezone,
    })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(eq(apiTokens.tokenHash, hash));
  if (!row) return null;

  const a = Buffer.from(hash);
  const b = Buffer.from(row.tokenHash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;

  try {
    await db
      .update(apiTokens)
      .set({ lastUsedAt: sql`now()` })
      .where(
        and(
          eq(apiTokens.id, row.id),
          sql`(${apiTokens.lastUsedAt} IS NULL OR ${apiTokens.lastUsedAt} < now() - interval '1 minute')`,
        ),
      );
  } catch (err) {
    console.error("Failed to update API token last_used_at", err instanceof Error ? err.message : "unknown");
  }

  return {
    userId: row.userId,
    timezone: row.timezone,
    tokenId: row.id,
    tokenName: row.name,
    scopes: row.scopes as AgentScope[],
  };
}
