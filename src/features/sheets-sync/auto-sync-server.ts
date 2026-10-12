/**
 * Server-side Google Sheet auto-sync helpers.
 *
 * - `syncDaysAfterChange` mirrors the browser's Timeline auto-sync
 *   (`src/lib/auto-sync.ts`) for writes that have no browser behind them
 *   (agent API): same gating (`autoSyncTasks`), `allowUnreviewed: true`,
 *   per-day coalescing. Best effort; never throws.
 * - `autoSyncAfterClose` is the clock-out / closed-attendance sync block
 *   shared by `POST /api/attendance/stop` and `POST /api/days/[date]/attendance`.
 *
 * Neither helper writes to the sheet directly: all cell writes go through
 * `executeSync`, which resolves targets, skips formulas and only writes
 * differing cells (idempotent).
 */
import { and, eq } from "drizzle-orm";
import { after } from "next/server";
import { setReviewed } from "@/features/daily-summary/service";
import { db } from "@/server/db";
import { dailyAttendance } from "@/server/db/schema";
import { getSheetsClient } from "./google";
import { executeSync, getSyncConfig, type SyncResult } from "./service";

/** Overall wall-clock budget for one `syncDaysAfterChange` call. */
export const SYNC_BUDGET_MS = 20_000;

export const NOT_SYNCED_HINT = "Not synced — open Timeline to sync this day";

export type AutoSyncSkipReason =
  | "not_configured"
  | "file_mode"
  | "auto_sync_tasks_off"
  | "no_google_client"
  | "budget_exhausted";

export type AutoSyncResult =
  | { attempted: false; reason: AutoSyncSkipReason }
  | {
      attempted: true;
      success: true;
      idempotent: boolean;
      changedCount: number;
    }
  | {
      attempted: true;
      success: false;
      code: "timeout";
      message: string;
    }
  | {
      attempted: true;
      success: false;
      code: "sync_error";
      message: string;
      hint: string;
    };

// ---------------------------------------------------------------------------
// Per-(user, day) coalescing: one run in flight, at most one queued follow-up.
// Callers arriving while a follow-up is already queued share that follow-up.
// ---------------------------------------------------------------------------

type Deferred = {
  promise: Promise<SyncResult>;
  resolve: (p: Promise<SyncResult>) => void;
};

type Slot = { running: Promise<SyncResult>; queued: Deferred | null };

const slots = new Map<string, Slot>();

/** Test helper: drop all coalescing state. */
export function __resetAutoSyncServerForTests(): void {
  slots.clear();
}

function deferred(): Deferred {
  let resolve!: (p: Promise<SyncResult>) => void;
  const promise = new Promise<SyncResult>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function startRun(
  key: string,
  slot: Slot,
  userId: string,
  dayKey: string,
): Promise<SyncResult> {
  // async IIFE: a synchronous throw becomes a rejection.
  const run = (async () =>
    executeSync(userId, dayKey, { allowUnreviewed: true }))();
  const settle = () => {
    const next = slot.queued;
    if (next) {
      slot.queued = null;
      slot.running = startRun(key, slot, userId, dayKey);
      next.resolve(slot.running);
    } else if (slots.get(key) === slot) {
      slots.delete(key);
    }
  };
  run.then(settle, settle);
  return run;
}

function coalescedSync(userId: string, dayKey: string): Promise<SyncResult> {
  const key = `${userId}:${dayKey}`;
  const existing = slots.get(key);
  if (existing) {
    if (!existing.queued) existing.queued = deferred();
    return existing.queued.promise;
  }
  const slot: Slot = { running: Promise.resolve(null as never), queued: null };
  slots.set(key, slot);
  slot.running = startRun(key, slot, userId, dayKey);
  return slot.running;
}

// ---------------------------------------------------------------------------
// syncDaysAfterChange
// ---------------------------------------------------------------------------

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function syncError(err: unknown): AutoSyncResult {
  return {
    attempted: true,
    success: false,
    code: "sync_error",
    message: errorMessage(err, "Sync failed"),
    hint: NOT_SYNCED_HINT,
  };
}

function keepAlive(pending: Promise<unknown>): void {
  const settled = pending.then(
    () => undefined,
    (err) => {
      console.error("Background sheet sync failed:", err);
    },
  );
  try {
    after(settled);
  } catch (err) {
    // Outside a request scope `after` throws; the promise still runs.
    console.error("Could not defer background sheet sync:", err);
  }
}

async function gate(
  userId: string,
): Promise<{ ok: true } | { ok: false; result: AutoSyncResult }> {
  try {
    const config = await getSyncConfig(userId);
    if (!config) {
      return { ok: false, result: { attempted: false, reason: "not_configured" } };
    }
    if (config.spreadsheetId === "file") {
      return { ok: false, result: { attempted: false, reason: "file_mode" } };
    }
    if (config.mapping.autoSyncTasks === false) {
      return {
        ok: false,
        result: { attempted: false, reason: "auto_sync_tasks_off" },
      };
    }
    const sheets = await getSheetsClient({ userId });
    if (!sheets) {
      return {
        ok: false,
        result: { attempted: false, reason: "no_google_client" },
      };
    }
    return { ok: true };
  } catch (err) {
    console.error("Sheet auto-sync gating failed:", err);
    return { ok: false, result: syncError(err) };
  }
}

async function syncOneDay(
  userId: string,
  dayKey: string,
  remainingMs: number,
): Promise<AutoSyncResult> {
  let pending: Promise<SyncResult>;
  try {
    pending = coalescedSync(userId, dayKey);
  } catch (err) {
    return syncError(err);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), remainingMs);
  });
  try {
    const outcome = await Promise.race([pending, timeout]);
    if (outcome === "timeout") {
      keepAlive(pending);
      return {
        attempted: true,
        success: false,
        code: "timeout",
        message: "Timed out",
      };
    }
    return {
      attempted: true,
      success: true,
      idempotent: outcome.idempotent,
      changedCount: outcome.changedCells.length,
    };
  } catch (err) {
    console.error(`Sheet auto-sync failed for ${dayKey}:`, err);
    return syncError(err);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Best-effort sync of the given local days after a server-side write.
 * Days run sequentially under one overall `SYNC_BUDGET_MS` budget. A day
 * that times out keeps running in the background (handed to `after()`).
 * Never throws; returns one result per (deduplicated) day key.
 */
export async function syncDaysAfterChange(
  userId: string,
  dayKeys: string[],
): Promise<Record<string, AutoSyncResult>> {
  const days = [...new Set(dayKeys)];
  const results: Record<string, AutoSyncResult> = {};
  if (days.length === 0) return results;

  const gated = await gate(userId);
  if (!gated.ok) {
    for (const day of days) results[day] = gated.result;
    return results;
  }

  const startedAt = Date.now();
  for (const day of days) {
    const remaining = SYNC_BUDGET_MS - (Date.now() - startedAt);
    if (remaining <= 0) {
      results[day] = { attempted: false, reason: "budget_exhausted" };
      continue;
    }
    results[day] = await syncOneDay(userId, day, remaining);
  }
  return results;
}

// ---------------------------------------------------------------------------
// autoSyncAfterClose
// ---------------------------------------------------------------------------

/** Response shape of `autoSync` in the attendance close routes. */
export type CloseAutoSyncResult = {
  attempted: boolean;
  success?: boolean;
  idempotent?: boolean;
  changedCount?: number;
  message?: string;
};

export type AutoSyncAfterCloseOptions = {
  accessToken?: string;
  /** Review state the day is reset to when the sync fails. */
  resetStateOnFailure: "draft" | "ready";
  /** Prefix for the failure log line. */
  logLabel?: string;
};

/**
 * Sync a closed attendance day (gated by `autoSyncOnClockOut !== false`):
 * mark the day reviewed, run `executeSync`, and on sync failure reset the
 * day to `resetStateOnFailure`. Sync failures are reported in the result;
 * errors from the config/client lookup or the reset itself propagate (the
 * existing routes turn them into 400s).
 */
export async function autoSyncAfterClose(
  userId: string,
  workDate: string,
  tz: string,
  options: AutoSyncAfterCloseOptions,
): Promise<CloseAutoSyncResult> {
  const config = await getSyncConfig(userId);
  if (!config || config.mapping.autoSyncOnClockOut === false) {
    return { attempted: false };
  }

  const sheets = await getSheetsClient({
    userId,
    accessToken: options.accessToken,
  });
  if (!sheets) return { attempted: false };

  try {
    // Mark the day reviewed so executeSync can run.
    await setReviewed(userId, workDate, tz);
    const syncRes = await executeSync(userId, workDate, {
      accessToken: options.accessToken,
    });
    return {
      attempted: true,
      success: true,
      idempotent: syncRes.idempotent,
      changedCount: syncRes.changedCells.length,
    };
  } catch (syncErr) {
    console.error(options.logLabel ?? "Auto-sync after close failed:", syncErr);
    await db
      .update(dailyAttendance)
      .set({
        reviewState: options.resetStateOnFailure,
        reviewedAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(dailyAttendance.userId, userId),
          eq(dailyAttendance.workDate, workDate),
        ),
      );
    return {
      attempted: true,
      success: false,
      message: syncErr instanceof Error ? syncErr.message : "Auto-sync failed",
    };
  }
}
