/**
 * Pending agent delete actions: request → (approve | reject | expire) state
 * machine over `agent_actions`, with request-time fingerprints so a target
 * that changed after the request is never deleted silently.
 *
 * States: pending → executing → executed | failed; pending → rejected |
 * expired. Expiry and stale `executing` recovery are swept lazily by
 * `sweepActions` (no cron).
 */
import { and, desc, eq, sql } from "drizzle-orm";

import { entryDurationMinutes } from "@/features/activities/domain";
import { entryDayKeys } from "@/features/activities/entry-helpers";
import { deleteEntry, deleteTask } from "@/features/activities/entry-mutations";
import { deleteBreak } from "@/features/attendance/service";
import { deleteCalendarEvent, getCalendarConfig } from "@/features/calendar-sync/service";
import { syncDaysAfterChange } from "@/features/sheets-sync/auto-sync-server";
import { getUserTimezone } from "@/features/sheets-sync/config";
import { zonedClock, zonedDayKey } from "@/lib/time";
import { isAuthBypassActive } from "@/server/auth";
import { db } from "@/server/db";
import {
  agentActions,
  apiTokens,
  breakEntries,
  calendarEvents,
  dailyAttendance,
  tasks,
  timeEntries,
} from "@/server/db/schema";
import { AuthBypassError, BadRequestError, ConflictError, NotFoundError } from "./errors";

/** The single result-code vocabulary (sweep, revoke, approve, sync; documented in SKILL.md). */
export const AGENT_ACTION_RESULT_CODES = [
  "gone",
  "stale",
  "timeout",
  "token_revoked",
  "expired",
  "execution_error",
  "sync_error",
] as const;
export type AgentActionResultCode = (typeof AGENT_ACTION_RESULT_CODES)[number];

export const DEFAULT_AGENT_ACTION_TTL_MINUTES = 1440;
export const MAX_AGENT_ACTION_TTL_MINUTES = 1440;
/** `executing` rows claimed longer ago than this are swept to `failed` / `timeout`. */
export const EXECUTING_TIMEOUT_MINUTES = 5;

export const DELETABLE_TARGET_TYPES = ["task", "time_entry", "calendar_event", "break"] as const;
export type DeletableTargetType = (typeof DELETABLE_TARGET_TYPES)[number];

export type AgentActionStatus =
  | "pending"
  | "executing"
  | "executed"
  | "failed"
  | "rejected"
  | "expired";

export interface TargetDescription {
  label: string;
  fingerprint: Record<string, unknown>;
  dayKeys: string[];
  impact: Record<string, unknown>;
}

export interface AgentActionDTO {
  id: string;
  kind: string;
  targetType: string;
  targetId: string | null;
  tokenId: string | null;
  tokenName: string | null;
  summary: Partial<TargetDescription> & Record<string, unknown>;
  reason: string | null;
  status: AgentActionStatus;
  result: Record<string, unknown> | null;
  expiresAt: string | null;
  claimedAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
  /** Pending rows only: the target as it is now (null when it no longer exists). */
  live?: TargetDescription | null;
  /** Pending rows only: target gone or its fingerprint differs from the request. */
  stale?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Structural equality for JSON values; object key order is ignored (jsonb reorders keys). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const bk = Object.keys(bo).filter((k) => bo[k] !== undefined);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
}

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

function localStamp(d: Date, tz: string): string {
  return `${zonedDayKey(d, tz)} ${zonedClock(d, tz)}`;
}

function span(start: Date, end: Date | null, tz: string): string {
  return `${localStamp(start, tz)}–${end ? zonedClock(end, tz) : "now"}`;
}

function isDeletableTargetType(value: string): value is DeletableTargetType {
  return (DELETABLE_TARGET_TYPES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// describeTarget
// ---------------------------------------------------------------------------

/**
 * Label, fingerprint, affected local day keys and impact of a delete target.
 * Every lookup is scoped by `id AND user_id`; null when missing or foreign.
 */
export async function describeTarget(
  userId: string,
  targetType: DeletableTargetType,
  targetId: string,
  tz: string,
): Promise<TargetDescription | null> {
  const now = new Date();
  switch (targetType) {
    case "task": {
      const [task] = await db
        .select({ id: tasks.id, name: tasks.name })
        .from(tasks)
        .where(and(eq(tasks.id, targetId), eq(tasks.userId, userId)))
        .limit(1);
      if (!task) return null;
      const entries = await db
        .select()
        .from(timeEntries)
        .where(and(eq(timeEntries.taskId, task.id), eq(timeEntries.userId, userId)));
      const completedMinutes = entries
        .filter((e) => e.status === "completed")
        .reduce((sum, e) => sum + entryDurationMinutes(e, now), 0);
      const totalMinutes = entries.reduce((sum, e) => sum + entryDurationMinutes(e, now), 0);
      const active = entries.find((e) => e.status === "active" || e.status === "paused") ?? null;
      const dayKeys = [
        ...new Set(entries.flatMap((e) => entryDayKeys(e.startedAt, e.endedAt, tz, now))),
      ].sort();
      return {
        label: task.name,
        fingerprint: { name: task.name, completedMinutes, activeEntryId: active?.id ?? null },
        dayKeys,
        impact: { entryCount: entries.length, totalMinutes, activeEntry: active !== null },
      };
    }
    case "time_entry": {
      const [row] = await db
        .select({ entry: timeEntries, taskName: tasks.name })
        .from(timeEntries)
        .innerJoin(tasks, eq(tasks.id, timeEntries.taskId))
        .where(and(eq(timeEntries.id, targetId), eq(timeEntries.userId, userId)))
        .limit(1);
      if (!row) return null;
      const { entry, taskName } = row;
      return {
        label: `${taskName} · ${span(entry.startedAt, entry.endedAt, tz)}`,
        fingerprint: {
          updatedAt: iso(entry.updatedAt),
          startedAt: iso(entry.startedAt),
          endedAt: iso(entry.endedAt),
          taskName,
        },
        dayKeys: entryDayKeys(entry.startedAt, entry.endedAt, tz, now),
        impact: { minutes: entryDurationMinutes(entry, now) },
      };
    }
    case "break": {
      const [row] = await db
        .select({
          startedAt: breakEntries.startedAt,
          endedAt: breakEntries.endedAt,
          workDate: dailyAttendance.workDate,
        })
        .from(breakEntries)
        .innerJoin(dailyAttendance, eq(dailyAttendance.id, breakEntries.attendanceId))
        .where(and(eq(breakEntries.id, targetId), eq(breakEntries.userId, userId)))
        .limit(1);
      if (!row) return null;
      const end = row.endedAt ?? now;
      return {
        label: `Break ${span(row.startedAt, row.endedAt, tz)}`,
        fingerprint: { startedAt: iso(row.startedAt), endedAt: iso(row.endedAt) },
        dayKeys: [row.workDate],
        impact: {
          minutes: Math.max(0, Math.floor((end.getTime() - row.startedAt.getTime()) / 60_000)),
        },
      };
    }
    case "calendar_event": {
      const [event] = await db
        .select()
        .from(calendarEvents)
        .where(and(eq(calendarEvents.id, targetId), eq(calendarEvents.userId, userId)))
        .limit(1);
      if (!event) return null;
      const guestCount = Array.isArray(event.guests) ? event.guests.length : 0;
      const { canWriteGoogle } = await getCalendarConfig(userId);
      return {
        label: `${event.title} · ${event.allDay ? zonedDayKey(event.startAt, tz) : localStamp(event.startAt, tz)}`,
        // Deliberately not updatedAt/htmlLink: every Google import bumps them.
        fingerprint: {
          title: event.title,
          startAt: iso(event.startAt),
          endAt: iso(event.endAt),
          allDay: event.allDay,
          googleEventId: event.googleEventId,
          sendUpdates: event.sendUpdates,
          guestCount,
        },
        dayKeys: [],
        impact: {
          googleLinked: !!event.googleEventId,
          guestCount,
          notifiesGuests: event.sendUpdates === "all" && guestCount > 0,
          canWriteGoogle,
        },
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Row access
// ---------------------------------------------------------------------------

const actionColumns = {
  id: agentActions.id,
  userId: agentActions.userId,
  kind: agentActions.kind,
  targetType: agentActions.targetType,
  targetId: agentActions.targetId,
  tokenId: agentActions.tokenId,
  tokenName: apiTokens.name,
  summary: agentActions.summary,
  reason: agentActions.reason,
  status: agentActions.status,
  result: agentActions.result,
  expiresAt: agentActions.expiresAt,
  claimedAt: agentActions.claimedAt,
  resolvedAt: agentActions.resolvedAt,
  createdAt: agentActions.createdAt,
};

type ActionRow = {
  id: string;
  kind: string;
  targetType: string;
  targetId: string | null;
  tokenId: string | null;
  tokenName: string | null;
  summary: unknown;
  reason: string | null;
  status: AgentActionStatus;
  result: unknown;
  expiresAt: Date | null;
  claimedAt: Date | null;
  resolvedAt: Date | null;
  createdAt: Date;
};

function toDTO(row: ActionRow): AgentActionDTO {
  return {
    id: row.id,
    kind: row.kind,
    targetType: row.targetType,
    targetId: row.targetId,
    tokenId: row.tokenId,
    tokenName: row.tokenName,
    summary: (row.summary ?? {}) as AgentActionDTO["summary"],
    reason: row.reason,
    status: row.status,
    result: (row.result ?? null) as AgentActionDTO["result"],
    expiresAt: iso(row.expiresAt),
    claimedAt: iso(row.claimedAt),
    resolvedAt: iso(row.resolvedAt),
    createdAt: row.createdAt.toISOString(),
  };
}

async function selectAction(userId: string, id: string): Promise<AgentActionDTO | null> {
  const [row] = await db
    .select(actionColumns)
    .from(agentActions)
    .leftJoin(apiTokens, eq(apiTokens.id, agentActions.tokenId))
    .where(and(eq(agentActions.id, id), eq(agentActions.userId, userId)))
    .limit(1);
  return row ? toDTO(row) : null;
}

async function withLive(userId: string, action: AgentActionDTO, tz: string): Promise<AgentActionDTO> {
  if (action.status !== "pending" || !action.targetId || !isDeletableTargetType(action.targetType)) {
    return action;
  }
  const live = await describeTarget(userId, action.targetType, action.targetId, tz);
  const stale = live === null || !deepEqual(live.fingerprint, action.summary.fingerprint);
  return { ...action, live, stale };
}

/** Moves an `executing` row to its final state; no-op if it is no longer executing. */
async function finalize(
  id: string,
  status: "executed" | "failed",
  result: Record<string, unknown>,
): Promise<void> {
  await db
    .update(agentActions)
    .set({ status, resolvedAt: sql`now()`, result })
    .where(and(eq(agentActions.id, id), eq(agentActions.status, "executing")));
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

/** Lazily expires overdue `pending` rows and fails `executing` rows claimed > 5 min ago. */
export async function sweepActions(userId: string): Promise<void> {
  await db
    .update(agentActions)
    .set({ status: "expired", resolvedAt: sql`now()`, result: { code: "expired" } })
    .where(
      and(
        eq(agentActions.userId, userId),
        eq(agentActions.status, "pending"),
        sql`${agentActions.expiresAt} <= now()`,
      ),
    );
  await db
    .update(agentActions)
    .set({
      status: "failed",
      resolvedAt: sql`now()`,
      result: { code: "timeout", error: "execution timed out" },
    })
    .where(
      and(
        eq(agentActions.userId, userId),
        eq(agentActions.status, "executing"),
        sql`${agentActions.claimedAt} <= now() - (${EXECUTING_TIMEOUT_MINUTES} * interval '1 minute')`,
      ),
    );
}

// ---------------------------------------------------------------------------
// requestDelete
// ---------------------------------------------------------------------------

export interface RequestDeleteContext {
  userId: string;
  timezone: string;
  tokenId: string | null;
}

export interface RequestDeleteInput {
  targetType: DeletableTargetType;
  targetId: string;
  reason?: string | null;
  expiresInMinutes?: number;
}

/**
 * Registers a pending delete (nothing is deleted). Returns the pending row;
 * a duplicate request for a target that already has a live pending row
 * returns that row.
 */
export async function requestDelete(
  ctx: RequestDeleteContext,
  input: RequestDeleteInput,
): Promise<AgentActionDTO> {
  if (isAuthBypassActive()) throw new AuthBypassError();
  if (!isDeletableTargetType(input.targetType)) {
    throw new BadRequestError(`Unsupported target type: ${String(input.targetType)}`);
  }

  const ttl = input.expiresInMinutes ?? DEFAULT_AGENT_ACTION_TTL_MINUTES;
  if (
    typeof ttl !== "number" ||
    !Number.isInteger(ttl) ||
    ttl < 1 ||
    ttl > MAX_AGENT_ACTION_TTL_MINUTES
  ) {
    throw new BadRequestError(`expiresInMinutes must be an integer between 1 and ${MAX_AGENT_ACTION_TTL_MINUTES}`);
  }

  const described = await describeTarget(ctx.userId, input.targetType, input.targetId, ctx.timezone);
  if (!described) throw new NotFoundError("Target not found");

  const tryInsert = async (): Promise<string | null> => {
    const [row] = await db
      .insert(agentActions)
      .values({
        userId: ctx.userId,
        tokenId: ctx.tokenId,
        kind: `${input.targetType}.delete`,
        targetType: input.targetType,
        targetId: input.targetId,
        summary: {
          label: described.label,
          fingerprint: described.fingerprint,
          dayKeys: described.dayKeys,
          impact: described.impact,
        },
        reason: input.reason ?? null,
        status: "pending",
        expiresAt: sql`now() + (${ttl} * interval '1 minute')`,
      })
      .onConflictDoNothing({
        target: [agentActions.userId, agentActions.targetType, agentActions.targetId],
        where: sql`status = 'pending'`,
      })
      .returning({ id: agentActions.id });
    return row?.id ?? null;
  };

  /** The live pending row for this target; an overdue one is expired and ignored. */
  const existingPending = async (): Promise<string | null> => {
    const [row] = await db
      .select({ id: agentActions.id, live: sql<boolean>`${agentActions.expiresAt} > now()` })
      .from(agentActions)
      .where(
        and(
          eq(agentActions.userId, ctx.userId),
          eq(agentActions.targetType, input.targetType),
          eq(agentActions.targetId, input.targetId),
          eq(agentActions.status, "pending"),
        ),
      )
      .limit(1);
    if (!row) return null;
    if (row.live) return row.id;
    await db
      .update(agentActions)
      .set({ status: "expired", resolvedAt: sql`now()`, result: { code: "expired" } })
      .where(
        and(
          eq(agentActions.id, row.id),
          eq(agentActions.status, "pending"),
          sql`${agentActions.expiresAt} <= now()`,
        ),
      );
    return null;
  };

  const id = (await tryInsert()) ?? (await existingPending()) ?? (await tryInsert()) ?? (await existingPending());
  if (!id) throw new ConflictError("Could not register the request, retry");

  const action = await selectAction(ctx.userId, id);
  if (!action) throw new ConflictError("Could not register the request, retry");
  return action;
}

// ---------------------------------------------------------------------------
// approve / reject
// ---------------------------------------------------------------------------

async function executeDelete(
  userId: string,
  targetType: DeletableTargetType,
  targetId: string,
  tz: string,
): Promise<{ ok: true; google?: unknown } | { ok: false; gone: true }> {
  switch (targetType) {
    case "task":
      return (await deleteTask(userId, targetId, tz)) ? { ok: true } : { ok: false, gone: true };
    case "time_entry":
      await deleteEntry(userId, targetId, tz);
      return { ok: true };
    case "break":
      await deleteBreak(userId, targetId, tz);
      return { ok: true };
    case "calendar_event": {
      const res = await deleteCalendarEvent(userId, targetId);
      return res.deleted ? { ok: true, google: res.google } : { ok: false, gone: true };
    }
  }
}

const GONE = { code: "gone", error: "Target no longer exists" } as const;

/**
 * Approves a pending delete: atomic `pending → executing` claim, staleness
 * check (against `expectedFingerprint` when given, else the request-time
 * fingerprint), delete, then `executed`/`failed`. Re-approving a finished
 * action returns it unchanged.
 */
export async function approveAction(
  userId: string,
  id: string,
  opts: { expectedFingerprint?: Record<string, unknown> | null } = {},
): Promise<AgentActionDTO> {
  await sweepActions(userId);

  const [claimed] = await db
    .update(agentActions)
    .set({ status: "executing", claimedAt: sql`now()` })
    .where(
      and(
        eq(agentActions.id, id),
        eq(agentActions.userId, userId),
        eq(agentActions.status, "pending"),
        sql`${agentActions.expiresAt} > now()`,
      ),
    )
    .returning();

  if (!claimed) {
    const current = await selectAction(userId, id);
    if (!current) throw new NotFoundError("Action not found");
    switch (current.status) {
      case "pending": {
        // Past expires_at but not yet swept (raced the sweep).
        await db
          .update(agentActions)
          .set({ status: "expired", resolvedAt: sql`now()`, result: { code: "expired" } })
          .where(and(eq(agentActions.id, id), eq(agentActions.status, "pending")));
        throw new ConflictError("Action expired", await selectAction(userId, id));
      }
      case "executing":
        throw new ConflictError("Already executing", current);
      case "executed":
      case "failed":
        return current;
      case "rejected":
        throw new ConflictError("Action was rejected", current);
      case "expired":
        throw new ConflictError("Action expired", current);
    }
  }

  const summary = (claimed.summary ?? {}) as Partial<TargetDescription>;
  try {
    if (!claimed.targetId || !isDeletableTargetType(claimed.targetType)) {
      await finalize(id, "failed", { code: "execution_error", error: "Unsupported target" });
      return (await selectAction(userId, id))!;
    }
    const targetType = claimed.targetType;
    const tz = await getUserTimezone(userId);
    const live = await describeTarget(userId, targetType, claimed.targetId, tz);
    if (!live) {
      await finalize(id, "failed", { ...GONE });
      return (await selectAction(userId, id))!;
    }
    const expected = opts.expectedFingerprint ?? summary.fingerprint;
    if (!deepEqual(live.fingerprint, expected)) {
      await finalize(id, "failed", {
        code: "stale",
        error: "Target changed since you reviewed it",
        live: live.fingerprint,
      });
      return (await selectAction(userId, id))!;
    }

    let outcome: Awaited<ReturnType<typeof executeDelete>>;
    try {
      outcome = await executeDelete(userId, targetType, claimed.targetId, tz);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Delete failed";
      await finalize(
        id,
        "failed",
        /not found/i.test(message) ? { ...GONE } : { code: "execution_error", error: message },
      );
      return (await selectAction(userId, id))!;
    }
    if (!outcome.ok) {
      await finalize(id, "failed", { ...GONE });
      return (await selectAction(userId, id))!;
    }

    const dayKeys = [...new Set([...(summary.dayKeys ?? []), ...live.dayKeys])].sort();
    const executedResult: Record<string, unknown> = {};
    if (outcome.google !== undefined) executedResult.google = outcome.google;
    // Task deletes never auto-sync (UI parity): the days only get flagged changed.
    if (targetType === "task") executedResult.needsSync = dayKeys;
    // Final immediately after the delete, even if the process dies next.
    await finalize(id, "executed", executedResult);

    if ((targetType === "time_entry" || targetType === "break") && dayKeys.length > 0) {
      const sheetSync = await syncDaysAfterChange(userId, dayKeys);
      await db
        .update(agentActions)
        .set({
          result: sql`coalesce(${agentActions.result}, '{}'::jsonb) || ${JSON.stringify({ sheetSync })}::jsonb`,
        })
        .where(eq(agentActions.id, id));
    }
  } catch (err) {
    console.error("Agent action approval failed", id, err instanceof Error ? err.message : "unknown");
    await finalize(id, "failed", {
      code: "execution_error",
      error: err instanceof Error ? err.message : "Execution failed",
    });
  }
  return (await selectAction(userId, id))!;
}

/** Rejects a pending action atomically; re-rejecting is idempotent. */
export async function rejectAction(userId: string, id: string): Promise<AgentActionDTO> {
  await sweepActions(userId);
  const [row] = await db
    .update(agentActions)
    .set({ status: "rejected", resolvedAt: sql`now()` })
    .where(
      and(
        eq(agentActions.id, id),
        eq(agentActions.userId, userId),
        eq(agentActions.status, "pending"),
      ),
    )
    .returning({ id: agentActions.id });

  const current = await selectAction(userId, id);
  if (!current) throw new NotFoundError("Action not found");
  if (row || current.status === "rejected") return current;
  switch (current.status) {
    case "executing":
      throw new ConflictError("Already executing", current);
    case "executed":
      throw new ConflictError("Action already executed", current);
    case "expired":
      throw new ConflictError("Action expired", current);
    default:
      throw new ConflictError(`Action is ${current.status}`, current);
  }
}

// ---------------------------------------------------------------------------
// list / get
// ---------------------------------------------------------------------------

export async function listActions(
  userId: string,
  opts: { status?: AgentActionStatus; limit?: number } = {},
): Promise<AgentActionDTO[]> {
  await sweepActions(userId);
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 200);
  const where = opts.status
    ? and(eq(agentActions.userId, userId), eq(agentActions.status, opts.status))
    : eq(agentActions.userId, userId);
  const rows = await db
    .select(actionColumns)
    .from(agentActions)
    .leftJoin(apiTokens, eq(apiTokens.id, agentActions.tokenId))
    .where(where)
    .orderBy(desc(agentActions.createdAt))
    .limit(limit);
  const actions = rows.map(toDTO);
  if (!actions.some((a) => a.status === "pending")) return actions;
  const tz = await getUserTimezone(userId);
  return Promise.all(actions.map((a) => withLive(userId, a, tz)));
}

export async function getAction(userId: string, id: string): Promise<AgentActionDTO> {
  await sweepActions(userId);
  const action = await selectAction(userId, id);
  if (!action) throw new NotFoundError("Action not found");
  if (action.status !== "pending") return action;
  return withLive(userId, action, await getUserTimezone(userId));
}
