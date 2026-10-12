/**
 * Agent API route wrapper: bearer-token auth, scope checks, error mapping,
 * best-effort audit recording and shared request parsers.
 */
import { NextResponse } from "next/server";
import { ZodError, z } from "zod";
import { OverlapError } from "@/features/activities/domain";
import { listCategories } from "@/features/activities/entry-queries";
import { todayKey } from "@/lib/time";
import { isAuthBypassActive } from "@/server/auth";
import { db } from "@/server/db";
import { agentActions } from "@/server/db/schema";
import { AuthBypassError, BadRequestError, ConflictError, ForbiddenScopeError, NotFoundError } from "./errors";
import { authBypassResponse } from "./session";
import {
  authenticateToken,
  scopeGrants,
  type AgentScope,
  type AgentTokenAuth,
} from "./tokens";

export type AgentContext = AgentTokenAuth;

const NO_STORE = { "Cache-Control": "no-store" } as const;

function json(body: unknown, status: number, extra?: Record<string, string>): NextResponse {
  return NextResponse.json(body, { status, headers: { ...NO_STORE, ...extra } });
}

/** Validates a route `[id]` param; returns a 400 response when it is not a uuid. */
export function parseIdParam(id: string): { ok: true; id: string } | { ok: false; response: NextResponse } {
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) return { ok: false, response: json({ error: "Invalid id" }, 400) };
  return { ok: true, id: parsed.data };
}

/**
 * Messages the shared activity/attendance/calendar services throw as plain
 * `Error`s for caller mistakes or state conflicts (the UI routes surface them
 * as 400s too). Matched exactly so unexpected errors (DB, "Failed to ...") fall
 * through to 500.
 */
const DOMAIN_BAD_REQUEST = new RegExp(
  `^(?:${[
    "No active task",
    "No paused task",
    "Already clocked in",
    "Not clocked in",
    "Already on break",
    "Not on break",
    "End time must be after start time",
    "Break overlaps with an existing break",
    "Task name cannot be empty",
    "Invalid start or end date format",
  ].join("|")})$`,
);

export function mapAgentError(error: unknown): NextResponse {
  if (error instanceof ForbiddenScopeError) {
    return json({ error: error.message, code: "insufficient_scope" }, 403);
  }
  if (error instanceof NotFoundError) {
    return json({ error: error.message, code: "not_found" }, 404);
  }
  if (error instanceof AuthBypassError) {
    return json({ error: error.message, code: "auth_bypass" }, 403);
  }
  if (error instanceof ConflictError) {
    const body: Record<string, unknown> = { error: error.message, code: "conflict" };
    if (error.action !== undefined) body.action = error.action;
    return json(body, 409);
  }
  if (error instanceof OverlapError) {
    return json({ error: error.message, details: error.details, code: "conflict" }, 409);
  }
  if (error instanceof ZodError) {
    return json({ error: error.issues[0]?.message ?? "Invalid request", code: "bad_request" }, 400);
  }
  if (error instanceof BadRequestError) {
    return json({ error: error.message, code: "bad_request" }, 400);
  }
  if (error instanceof Error) {
    // Shared services throw plain Errors for user-facing domain failures.
    if (/not found/i.test(error.message)) {
      return json({ error: error.message, code: "not_found" }, 404);
    }
    if (DOMAIN_BAD_REQUEST.test(error.message)) {
      return json({ error: error.message, code: "bad_request" }, 400);
    }
  }
  // Anything else is unexpected: log the real error, never leak it to the caller.
  console.error("Agent API unexpected error", error instanceof Error ? error.message : "unknown");
  return json({ error: "Internal error", code: "internal_error" }, 500);
}

function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

type RouteContext<P> = { params: Promise<P> };

export function withAgentAuth<P = Record<string, never>>(
  scope: AgentScope,
  handler: (ctx: AgentContext, req: Request, params: P) => Promise<Response>,
): (req: Request, routeCtx?: RouteContext<P>) => Promise<Response> {
  return async (req, routeCtx) => {
    if (isAuthBypassActive()) return authBypassResponse();

    const token = bearerToken(req);
    const unauthorized = () => json({ error: "Unauthorized", code: "invalid_token" }, 401);
    if (!token) return unauthorized();

    let ctx: AgentContext | null;
    try {
      ctx = await authenticateToken(token);
    } catch (err) {
      console.error("Agent token authentication failed", err instanceof Error ? err.message : "unknown");
      return json({ error: "Authentication unavailable", code: "auth_unavailable" }, 503);
    }
    if (!ctx) return unauthorized();

    if (!scopeGrants(ctx.scopes, scope)) {
      return json({ error: `Token lacks the "${scope}" scope`, code: "insufficient_scope" }, 403);
    }

    try {
      const params = (routeCtx ? await routeCtx.params : {}) as P;
      const res = await handler(ctx, req, params);
      res.headers.set("Cache-Control", "no-store");
      return res;
    } catch (error) {
      return mapAgentError(error);
    }
  };
}

export interface RecordAgentActionInput {
  kind: string;
  targetType: "task" | "time_entry" | "calendar_event" | "break" | "attendance";
  targetId?: string | null;
  summary: Record<string, unknown>;
  status?: "executed" | "failed";
  result?: unknown;
}

/** Best-effort audit insert; logs and returns null on failure, never throws. */
export async function recordAgentAction(
  ctx: AgentContext,
  input: RecordAgentActionInput,
): Promise<string | null> {
  try {
    const [row] = await db
      .insert(agentActions)
      .values({
        userId: ctx.userId,
        tokenId: ctx.tokenId,
        kind: input.kind,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        summary: input.summary,
        status: input.status ?? "executed",
        result: input.result ?? null,
      })
      .returning({ id: agentActions.id });
    return row?.id ?? null;
  } catch (err) {
    console.error("Failed to record agent action", input.kind, err instanceof Error ? err.message : "unknown");
    return null;
  }
}

const dayKeySchema = z.iso.date();

/** Optional `date=YYYY-MM-DD`, defaulting to today in `tz`. Throws ZodError-mapped 400 on bad format. */
export function dayParam(url: URL, tz: string): string {
  const raw = url.searchParams.get("date");
  if (raw === null || raw === "") return todayKey(tz);
  const parsed = dayKeySchema.safeParse(raw);
  if (!parsed.success) throw new BadRequestError("Invalid date, expected YYYY-MM-DD");
  return parsed.data;
}

/** Resolves a category uuid from `categoryId` or `categoryKey`. */
export async function resolveCategoryId(input: {
  categoryId?: string;
  categoryKey?: string;
}): Promise<string> {
  const all = await listCategories();
  const match = input.categoryId
    ? all.find((c) => c.id === input.categoryId)
    : input.categoryKey
      ? all.find((c) => c.key === input.categoryKey)
      : undefined;
  if (!match) throw new NotFoundError("Category not found");
  return match.id;
}
