import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  setReviewed: vi.fn(),
  getSheetsClient: vi.fn(),
  executeSync: vi.fn(),
  getSyncConfig: vi.fn(),
  dbSet: vi.fn(),
  dbWhere: vi.fn(),
}));

// Never reach real Google Sheets or a real database.
vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/features/daily-summary/service", () => ({
  setReviewed: mocks.setReviewed,
}));
vi.mock("./google", () => ({ getSheetsClient: mocks.getSheetsClient }));
vi.mock("./service", () => ({
  executeSync: mocks.executeSync,
  getSyncConfig: mocks.getSyncConfig,
}));
vi.mock("@/server/db", () => ({
  db: {
    update: () => ({
      set: (v: unknown) => {
        mocks.dbSet(v);
        return { where: mocks.dbWhere };
      },
    }),
  },
}));

import {
  __resetAutoSyncServerForTests,
  autoSyncAfterClose,
  NOT_SYNCED_HINT,
  SYNC_BUDGET_MS,
  syncDaysAfterChange,
} from "./auto-sync-server";

const ok = (changed = 2, idempotent = false) => ({
  status: "success" as const,
  changedCells: Array.from({ length: changed }, (_, i) => ({
    a1: `B${i + 1}`,
    value: "1:00",
  })),
  idempotent,
});

function defer<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let pending microtasks (promise chains) run. */
async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.resetAllMocks();
  __resetAutoSyncServerForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.getSyncConfig.mockResolvedValue({
    spreadsheetId: "sheet-copy",
    mapping: { autoSyncTasks: true, autoSyncOnClockOut: true },
  });
  mocks.getSheetsClient.mockResolvedValue({});
  mocks.executeSync.mockResolvedValue(ok());
  mocks.dbWhere.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("syncDaysAfterChange gating", () => {
  it.each([
    ["not_configured", null],
    ["file_mode", { spreadsheetId: "file", mapping: {} }],
    [
      "auto_sync_tasks_off",
      { spreadsheetId: "sheet-copy", mapping: { autoSyncTasks: false } },
    ],
  ])("returns attempted:false with reason %s", async (reason, config) => {
    mocks.getSyncConfig.mockResolvedValue(config);
    const res = await syncDaysAfterChange("u1", ["2026-10-12", "2026-10-13"]);
    expect(res).toEqual({
      "2026-10-12": { attempted: false, reason },
      "2026-10-13": { attempted: false, reason },
    });
    expect(mocks.executeSync).not.toHaveBeenCalled();
  });

  it("returns no_google_client when no Sheets client is available", async () => {
    mocks.getSheetsClient.mockResolvedValue(null);
    const res = await syncDaysAfterChange("u1", ["2026-10-12"]);
    expect(res).toEqual({
      "2026-10-12": { attempted: false, reason: "no_google_client" },
    });
    expect(mocks.getSheetsClient).toHaveBeenCalledWith({ userId: "u1" });
    expect(mocks.executeSync).not.toHaveBeenCalled();
  });

  it("gates once per call and returns {} for no days", async () => {
    expect(await syncDaysAfterChange("u1", [])).toEqual({});
    expect(mocks.getSyncConfig).not.toHaveBeenCalled();
    await syncDaysAfterChange("u1", ["2026-10-12", "2026-10-13"]);
    expect(mocks.getSyncConfig).toHaveBeenCalledTimes(1);
    expect(mocks.getSheetsClient).toHaveBeenCalledTimes(1);
  });

  it("never throws when gating fails", async () => {
    mocks.getSyncConfig.mockRejectedValue(new Error("db down"));
    const res = await syncDaysAfterChange("u1", ["2026-10-12"]);
    expect(res["2026-10-12"]).toEqual({
      attempted: true,
      success: false,
      code: "sync_error",
      message: "db down",
      hint: NOT_SYNCED_HINT,
    });
  });
});

describe("syncDaysAfterChange results", () => {
  it("returns the success shape and syncs unreviewed days", async () => {
    mocks.executeSync.mockResolvedValue(ok(3, false));
    const res = await syncDaysAfterChange("u1", ["2026-10-12"]);
    expect(res).toEqual({
      "2026-10-12": {
        attempted: true,
        success: true,
        idempotent: false,
        changedCount: 3,
      },
    });
    expect(mocks.executeSync).toHaveBeenCalledWith("u1", "2026-10-12", {
      allowUnreviewed: true,
    });
  });

  it("returns the failure shape with hint and never throws", async () => {
    mocks.executeSync.mockRejectedValue(new Error("Date row not found"));
    const res = await syncDaysAfterChange("u1", ["2026-10-12"]);
    expect(res["2026-10-12"]).toEqual({
      attempted: true,
      success: false,
      code: "sync_error",
      message: "Date row not found",
      hint: "Not synced — open Timeline to sync this day",
    });
  });

  it("handles a synchronous throw from executeSync", async () => {
    mocks.executeSync.mockImplementation(() => {
      throw new Error("sync throw");
    });
    const res = await syncDaysAfterChange("u1", ["2026-10-12"]);
    expect(res["2026-10-12"]).toMatchObject({
      success: false,
      code: "sync_error",
      message: "sync throw",
    });
  });

  it("dedupes day keys", async () => {
    await syncDaysAfterChange("u1", ["2026-10-12", "2026-10-12"]);
    expect(mocks.executeSync).toHaveBeenCalledTimes(1);
  });

  it("times out, hands the pending sync to after(), and it keeps running", async () => {
    vi.useFakeTimers();
    const d = defer<ReturnType<typeof ok>>();
    mocks.executeSync.mockReturnValue(d.promise);

    const call = syncDaysAfterChange("u1", ["2026-10-12"]);
    await vi.advanceTimersByTimeAsync(SYNC_BUDGET_MS);
    const res = await call;

    expect(res["2026-10-12"]).toEqual({
      attempted: true,
      success: false,
      code: "timeout",
      message: "Timed out",
    });
    expect(mocks.after).toHaveBeenCalledTimes(1);
    const handed = mocks.after.mock.calls[0]![0] as Promise<unknown>;
    expect(handed).toBeInstanceOf(Promise);

    // The handed promise settles only when the underlying sync does.
    let settled = false;
    void handed.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    d.resolve(ok());
    await flush();
    expect(settled).toBe(true);
  });

  it("does not reject the after() promise when the background sync fails", async () => {
    vi.useFakeTimers();
    const d = defer<ReturnType<typeof ok>>();
    mocks.executeSync.mockReturnValue(d.promise);
    const call = syncDaysAfterChange("u1", ["2026-10-12"]);
    await vi.advanceTimersByTimeAsync(SYNC_BUDGET_MS);
    await call;
    const handed = mocks.after.mock.calls[0]![0] as Promise<unknown>;
    d.reject(new Error("late failure"));
    await expect(handed).resolves.toBeUndefined();
  });

  it("still returns timeout when after() throws outside a request scope", async () => {
    vi.useFakeTimers();
    mocks.after.mockImplementation(() => {
      throw new Error("after() outside request scope");
    });
    mocks.executeSync.mockReturnValue(new Promise(() => {}));
    const call = syncDaysAfterChange("u1", ["2026-10-12"]);
    await vi.advanceTimersByTimeAsync(SYNC_BUDGET_MS);
    expect((await call)["2026-10-12"]).toMatchObject({ code: "timeout" });
  });

  it("syncs days sequentially and exhausts the shared budget", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const pending = new Map<string, ReturnType<typeof defer<ReturnType<typeof ok>>>>();
    mocks.executeSync.mockImplementation((_u: string, day: string) => {
      order.push(`start:${day}`);
      const d = defer<ReturnType<typeof ok>>();
      pending.set(day, d);
      return d.promise.then((r) => {
        order.push(`end:${day}`);
        return r;
      });
    });

    const call = syncDaysAfterChange("u1", ["2026-10-10", "2026-10-11", "2026-10-12"]);
    await flush();
    expect(order).toEqual(["start:2026-10-10"]);

    // Each sync takes 10 s of wall clock (Date.now only, so the per-day
    // timeout timer does not fire before the sync resolves).
    vi.setSystemTime(Date.now() + 10_000);
    pending.get("2026-10-10")!.resolve(ok(1));
    await flush();
    expect(order).toEqual(["start:2026-10-10", "end:2026-10-10", "start:2026-10-11"]);

    vi.setSystemTime(Date.now() + 10_000);
    pending.get("2026-10-11")!.resolve(ok(1));
    const res = await call;

    expect(order).toEqual([
      "start:2026-10-10",
      "end:2026-10-10",
      "start:2026-10-11",
      "end:2026-10-11",
    ]);
    expect(mocks.executeSync.mock.calls.map((c) => c[1])).toEqual([
      "2026-10-10",
      "2026-10-11",
    ]);
    expect(res["2026-10-10"]).toMatchObject({ success: true });
    expect(res["2026-10-11"]).toMatchObject({ success: true });
    expect(res["2026-10-12"]).toEqual({
      attempted: false,
      reason: "budget_exhausted",
    });
  });

  it("gives the second day only the remaining budget", async () => {
    vi.useFakeTimers();
    let n = 0;
    const first = defer<ReturnType<typeof ok>>();
    mocks.executeSync.mockImplementation(() =>
      n++ === 0 ? first.promise : new Promise(() => {}),
    );
    const call = syncDaysAfterChange("u1", ["2026-10-10", "2026-10-11", "2026-10-12"]);
    await vi.advanceTimersByTimeAsync(15_000);
    first.resolve(ok());
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);
    const res = await call;
    expect(res["2026-10-11"]).toMatchObject({ code: "timeout" });
    expect(res["2026-10-12"]).toEqual({
      attempted: false,
      reason: "budget_exhausted",
    });
  });
});

describe("syncDaysAfterChange coalescing", () => {
  it("runs one in flight plus at most one queued follow-up per user/day", async () => {
    const runs: ReturnType<typeof defer<ReturnType<typeof ok>>>[] = [];
    mocks.executeSync.mockImplementation(() => {
      const d = defer<ReturnType<typeof ok>>();
      runs.push(d);
      return d.promise;
    });

    const a = syncDaysAfterChange("u1", ["2026-10-12"]);
    const b = syncDaysAfterChange("u1", ["2026-10-12"]);
    const c = syncDaysAfterChange("u1", ["2026-10-12"]);
    await flush();
    expect(mocks.executeSync).toHaveBeenCalledTimes(1);

    runs[0]!.resolve(ok(1));
    await flush();
    // b and c share the single queued follow-up.
    expect(mocks.executeSync).toHaveBeenCalledTimes(2);
    runs[1]!.resolve(ok(4));

    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect(mocks.executeSync).toHaveBeenCalledTimes(2);
    expect(ra["2026-10-12"]).toMatchObject({ changedCount: 1 });
    expect(rb["2026-10-12"]).toMatchObject({ changedCount: 4 });
    expect(rc["2026-10-12"]).toMatchObject({ changedCount: 4 });

    // Slot is released: a later call starts a fresh run.
    mocks.executeSync.mockResolvedValue(ok(0, true));
    await syncDaysAfterChange("u1", ["2026-10-12"]);
    expect(mocks.executeSync).toHaveBeenCalledTimes(3);
  });

  it("runs the queued follow-up even when the first run fails", async () => {
    const first = defer<ReturnType<typeof ok>>();
    mocks.executeSync
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(ok(2));
    const a = syncDaysAfterChange("u1", ["2026-10-12"]);
    const b = syncDaysAfterChange("u1", ["2026-10-12"]);
    await flush();
    first.reject(new Error("transient"));
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra["2026-10-12"]).toMatchObject({ code: "sync_error" });
    expect(rb["2026-10-12"]).toMatchObject({ success: true, changedCount: 2 });
    expect(mocks.executeSync).toHaveBeenCalledTimes(2);
  });

  it("runs the same day for two different users immediately and independently", async () => {
    const runs = new Map<string, ReturnType<typeof defer<ReturnType<typeof ok>>>>();
    mocks.executeSync.mockImplementation((user: string) => {
      const d = defer<ReturnType<typeof ok>>();
      runs.set(user, d);
      return d.promise;
    });

    const a = syncDaysAfterChange("u1", ["2026-10-12"]);
    const b = syncDaysAfterChange("u2", ["2026-10-12"]);
    await flush();
    expect(mocks.executeSync).toHaveBeenCalledTimes(2);
    expect(mocks.executeSync.mock.calls.map((c) => c[0]).sort()).toEqual([
      "u1",
      "u2",
    ]);

    runs.get("u2")!.resolve(ok(5));
    expect((await b)["2026-10-12"]).toMatchObject({ changedCount: 5 });
    runs.get("u1")!.resolve(ok(1));
    expect((await a)["2026-10-12"]).toMatchObject({ changedCount: 1 });
  });
});

describe("autoSyncAfterClose", () => {
  it("marks reviewed then syncs, returning the existing autoSync shape", async () => {
    mocks.executeSync.mockResolvedValue(ok(2, false));
    const res = await autoSyncAfterClose("u1", "2026-10-12", "Asia/Jakarta", {
      accessToken: "tok",
      resetStateOnFailure: "draft",
    });
    expect(res).toEqual({
      attempted: true,
      success: true,
      idempotent: false,
      changedCount: 2,
    });
    expect(mocks.getSheetsClient).toHaveBeenCalledWith({
      userId: "u1",
      accessToken: "tok",
    });
    expect(mocks.setReviewed).toHaveBeenCalledWith(
      "u1",
      "2026-10-12",
      "Asia/Jakarta",
    );
    expect(mocks.executeSync).toHaveBeenCalledWith("u1", "2026-10-12", {
      accessToken: "tok",
    });
    expect(mocks.setReviewed.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.executeSync.mock.invocationCallOrder[0]!,
    );
  });

  it.each([
    ["no config", null],
    [
      "autoSyncOnClockOut off",
      { spreadsheetId: "sheet-copy", mapping: { autoSyncOnClockOut: false } },
    ],
  ])("does not attempt with %s", async (_label, config) => {
    mocks.getSyncConfig.mockResolvedValue(config);
    const res = await autoSyncAfterClose("u1", "2026-10-12", "Asia/Jakarta", {
      resetStateOnFailure: "draft",
    });
    expect(res).toEqual({ attempted: false });
    expect(mocks.getSheetsClient).not.toHaveBeenCalled();
  });

  it("does not attempt without a Sheets client", async () => {
    mocks.getSheetsClient.mockResolvedValue(null);
    const res = await autoSyncAfterClose("u1", "2026-10-12", "Asia/Jakarta", {
      resetStateOnFailure: "ready",
    });
    expect(res).toEqual({ attempted: false });
    expect(mocks.setReviewed).not.toHaveBeenCalled();
  });

  it.each(["draft", "ready"] as const)(
    "resets the day to %s on sync failure",
    async (state) => {
      mocks.executeSync.mockRejectedValue(new Error("Sheets 500"));
      const res = await autoSyncAfterClose("u1", "2026-10-12", "Asia/Jakarta", {
        resetStateOnFailure: state,
      });
      expect(res).toEqual({
        attempted: true,
        success: false,
        message: "Sheets 500",
      });
      expect(mocks.dbSet).toHaveBeenCalledTimes(1);
      expect(mocks.dbSet).toHaveBeenCalledWith({
        reviewState: state,
        reviewedAt: null,
        updatedAt: expect.any(Date),
      });
      expect(mocks.dbWhere).toHaveBeenCalledTimes(1);
    },
  );

  it("resets when setReviewed fails and uses the generic message for non-Errors", async () => {
    mocks.setReviewed.mockRejectedValue("nope");
    const res = await autoSyncAfterClose("u1", "2026-10-12", "Asia/Jakarta", {
      resetStateOnFailure: "ready",
    });
    expect(res).toEqual({
      attempted: true,
      success: false,
      message: "Auto-sync failed",
    });
    expect(mocks.executeSync).not.toHaveBeenCalled();
    expect(mocks.dbSet).toHaveBeenCalledWith(
      expect.objectContaining({ reviewState: "ready" }),
    );
  });

  it("propagates config lookup errors (routes map them to 400)", async () => {
    mocks.getSyncConfig.mockRejectedValue(new Error("db down"));
    await expect(
      autoSyncAfterClose("u1", "2026-10-12", "Asia/Jakarta", {
        resetStateOnFailure: "draft",
      }),
    ).rejects.toThrow("db down");
  });
});
