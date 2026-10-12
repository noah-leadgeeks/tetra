/**
 * Shared plumbing for the agent write endpoints: body parsing, audited
 * execution, user-scoped pre-update lookups and best-effort sheet sync.
 */
import { and, eq, sql } from "drizzle-orm";
import type { z } from "zod";
import { entryDayKeys } from "@/features/activities/entry-helpers";
import {
  autoSyncAfterClose,
  syncDaysAfterChange,
  type AutoSyncResult,
  type CloseAutoSyncResult,
} from "@/features/sheets-sync/auto-sync-server";
import { syncClockIn } from "@/features/sheets-sync/service";
import { db } from "@/server/db";
import { agentActions, breakEntries, dailyAttendance, timeEntries } from "@/server/db/schema";
import { BadRequestError, NotFoundError } from "./errors";
import {
  recordAgentAction,
  resolveCategoryId,
  type AgentContext,
  type RecordAgentActionInput,
} from "./http";

/**
 * Parses an optional JSON body (empty body = `{}`) with `schema`.
 * Malformed JSON and schema failures surface as 400 through `withAgentAuth`.
 */
export async function parseAgentBody<S extends z.ZodType>(
  req: Request,
  schema: S,
): Promise<z.output<S>> {
  const text = await req.text().catch(() => "");
  let raw: unknown = {};
  if (text.trim() !== "") {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new BadRequestError("Invalid JSON body");
    }
  }
  return schema.parse(raw);
}

/** Validation (400, before any audit): one of `categoryId` / `categoryKey` is required. */
export function assertCategoryGiven(input: { categoryId?: string; categoryKey?: string }): void {
  if (!input.categoryId && !input.categoryKey) {
    throw new BadRequestError("categoryId or categoryKey is required");
  }
}

/** Resolves an optional category (`undefined` when neither field is given; 404 when unknown). */
export async function optionalCategoryId(input: {
  categoryId?: string;
  categoryKey?: string;
}): Promise<string | undefined> {
  if (!input.categoryId && !input.categoryKey) return undefined;
  return resolveCategoryId(input);
}

export type AuditMeta = Omit<RecordAgentActionInput, "status" | "result">;

/**
 * Runs a validated write and records it in `agent_actions`: `executed` with
 * `describe(value)` on success, `failed` with the error message on failure
 * (the error is re-thrown so `withAgentAuth` maps it). Audit failures never
 * change the response (`recordAgentAction` is best-effort).
 *
 * Returns the written value plus the audit row id (`null` when the audit
 * insert failed) so the route can merge its sheet-sync outcome into that row
 * with `recordSyncOutcome`.
 */
export async function auditedWriteWithId<T>(
  ctx: AgentContext,
  meta: AuditMeta,
  run: () => Promise<T>,
  describe?: (value: T) => { targetId?: string | null; result?: unknown },
): Promise<{ value: T; auditId: string | null }> {
  let value: T;
  try {
    value = await run();
  } catch (error) {
    await recordAgentAction(ctx, {
      ...meta,
      status: "failed",
      result: { error: error instanceof Error ? error.message : "Request failed" },
    });
    throw error;
  }
  const extra = describe?.(value) ?? {};
  const auditId = await recordAgentAction(ctx, {
    ...meta,
    targetId: extra.targetId !== undefined ? extra.targetId : meta.targetId,
    status: "executed",
    result: extra.result,
  });
  return { value, auditId: auditId ?? null };
}

/** `auditedWriteWithId` for routes that do not need the audit row id. */
export async function auditedWrite<T>(
  ctx: AgentContext,
  meta: AuditMeta,
  run: () => Promise<T>,
  describe?: (value: T) => { targetId?: string | null; result?: unknown },
): Promise<T> {
  return (await auditedWriteWithId(ctx, meta, run, describe)).value;
}

/**
 * Best-effort: merges the sheet-sync outcome (`{ sheetSync }` / `{ autoSync }`)
 * into the audit row's `result`, like the approval flow does for deletes.
 * Logs and swallows failures; a no-op when the audit insert had failed.
 */
export async function recordSyncOutcome(
  auditId: string | null | undefined,
  outcome: Record<string, unknown>,
): Promise<void> {
  if (!auditId) return;
  try {
    await db
      .update(agentActions)
      .set({
        result: sql`coalesce(${agentActions.result}, '{}'::jsonb) || ${JSON.stringify(outcome)}::jsonb`,
      })
      .where(eq(agentActions.id, auditId));
  } catch (err) {
    console.error("Failed to record agent sync outcome", err instanceof Error ? err.message : "unknown");
  }
}

/** User-scoped time-entry lookup (foreign or unknown ids → 404). */
export async function findUserEntrySpan(
  userId: string,
  id: string,
): Promise<{ startedAt: Date; endedAt: Date | null }> {
  const [row] = await db
    .select({ startedAt: timeEntries.startedAt, endedAt: timeEntries.endedAt })
    .from(timeEntries)
    .where(and(eq(timeEntries.id, id), eq(timeEntries.userId, userId)))
    .limit(1);
  if (!row) throw new NotFoundError("Entry not found");
  return row;
}

/** User-scoped break lookup joined to its attendance day (foreign or unknown ids → 404). */
export async function findUserBreakWorkDate(userId: string, id: string): Promise<string> {
  const [row] = await db
    .select({ workDate: dailyAttendance.workDate })
    .from(breakEntries)
    .innerJoin(dailyAttendance, eq(breakEntries.attendanceId, dailyAttendance.id))
    .where(and(eq(breakEntries.id, id), eq(breakEntries.userId, userId)))
    .limit(1);
  if (!row) throw new NotFoundError("Break not found");
  return row.workDate;
}

type Span = { startedAt: Date | string; endedAt: Date | string | null };

/** Union of the user-timezone day keys of every span, sorted. */
export function spanDayKeys(spans: Span[], timeZone: string): string[] {
  const keys = new Set<string>();
  for (const span of spans) {
    const start = new Date(span.startedAt);
    const end = span.endedAt === null ? null : new Date(span.endedAt);
    for (const key of entryDayKeys(start, end, timeZone)) keys.add(key);
  }
  return [...keys].sort();
}

/** Best-effort sheet sync of the days touched by `spans` (never throws). */
export function syncSpans(
  ctx: AgentContext,
  spans: Span[],
): Promise<Record<string, AutoSyncResult>> {
  return syncDaysAfterChange(ctx.userId, spanDayKeys(spans, ctx.timezone));
}

/**
 * `autoSyncAfterClose` for agent routes: a thrown config/client/reset error is
 * reported as `success: false` instead of failing the already-applied write.
 */
export async function safeAutoSyncAfterClose(
  ctx: AgentContext,
  workDate: string,
  resetStateOnFailure: "draft" | "ready",
): Promise<CloseAutoSyncResult> {
  try {
    return await autoSyncAfterClose(ctx.userId, workDate, ctx.timezone, {
      resetStateOnFailure,
      logLabel: "Agent auto-sync after close failed:",
    });
  } catch (error) {
    console.error(
      "Agent auto-sync after close threw",
      error instanceof Error ? error.message : "unknown",
    );
    return {
      attempted: true,
      success: false,
      message: error instanceof Error ? error.message : "Auto-sync failed",
    };
  }
}

/** `syncClockIn` for agent routes: a thrown error never fails the clock-in. */
export async function safeSyncClockIn(
  ctx: AgentContext,
  workDate: string,
  clockInAt: string,
): Promise<Awaited<ReturnType<typeof syncClockIn>>> {
  try {
    return await syncClockIn(ctx.userId, workDate, clockInAt, {});
  } catch (error) {
    console.error(
      "Agent clock-in sync threw",
      error instanceof Error ? error.message : "unknown",
    );
    return {
      attempted: true,
      success: false,
      message: error instanceof Error ? error.message : "Clock-in sync failed",
    };
  }
}
