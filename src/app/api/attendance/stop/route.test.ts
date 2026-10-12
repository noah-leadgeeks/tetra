import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  clockOut: vi.fn(),
  setReviewed: vi.fn(),
  getSheetsClient: vi.fn(),
  executeSync: vi.fn(),
  getSyncConfig: vi.fn(),
  dbSet: vi.fn(),
  dbWhere: vi.fn(),
}));

vi.mock("@/server/auth", () => ({ auth: mocks.auth }));
vi.mock("@/features/attendance/service", () => ({ clockOut: mocks.clockOut }));
vi.mock("@/features/daily-summary/service", () => ({
  setReviewed: mocks.setReviewed,
}));
vi.mock("@/features/sheets-sync/google", () => ({
  getSheetsClient: mocks.getSheetsClient,
}));
vi.mock("@/features/sheets-sync/service", () => ({
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

import { POST } from "./route";

const attendance = {
  id: "att-1",
  workDate: "2026-10-12",
  status: "closed",
  clockInAt: "2026-10-12T01:00:00.000Z",
  clockOutAt: "2026-10-12T10:00:00.000Z",
};

function post(body: unknown = {}) {
  return POST(
    new Request("http://localhost/api/attendance/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.auth.mockResolvedValue({
    user: { id: "user-1", timezone: "Asia/Jakarta" },
    accessToken: "tok",
  });
  mocks.clockOut.mockResolvedValue(attendance);
  mocks.getSyncConfig.mockResolvedValue({
    spreadsheetId: "sheet-1",
    mapping: { autoSyncOnClockOut: true },
  });
  mocks.getSheetsClient.mockResolvedValue({});
  mocks.setReviewed.mockResolvedValue({ reviewState: "reviewed" });
  mocks.executeSync.mockResolvedValue({
    status: "success",
    changedCells: [{ a1: "B5", value: "8:00" }],
    idempotent: false,
  });
  mocks.dbWhere.mockResolvedValue(undefined);
});

describe("POST /api/attendance/stop", () => {
  it("returns 401 without a session", async () => {
    mocks.auth.mockResolvedValue(null);
    const res = await post();
    expect(res.status).toBe(401);
    expect(await res.text()).toBe(JSON.stringify({ error: "Unauthorized" }));
  });

  it("spreads the attendance and adds a successful autoSync", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(
      JSON.stringify({
        ...attendance,
        autoSync: {
          attempted: true,
          success: true,
          idempotent: false,
          changedCount: 1,
        },
      }),
    );
    expect(mocks.getSheetsClient).toHaveBeenCalledWith({
      userId: "user-1",
      accessToken: "tok",
    });
    expect(mocks.setReviewed).toHaveBeenCalledWith(
      "user-1",
      "2026-10-12",
      "Asia/Jakarta",
    );
    expect(mocks.executeSync).toHaveBeenCalledWith("user-1", "2026-10-12", {
      accessToken: "tok",
    });
  });

  it("does not attempt when no config", async () => {
    mocks.getSyncConfig.mockResolvedValue(null);
    const res = await post();
    expect(await res.text()).toBe(
      JSON.stringify({ ...attendance, autoSync: { attempted: false } }),
    );
    expect(mocks.getSheetsClient).not.toHaveBeenCalled();
  });

  it("does not attempt when autoSyncOnClockOut is false", async () => {
    mocks.getSyncConfig.mockResolvedValue({
      spreadsheetId: "sheet-1",
      mapping: { autoSyncOnClockOut: false },
    });
    const res = await post();
    expect(await res.text()).toBe(
      JSON.stringify({ ...attendance, autoSync: { attempted: false } }),
    );
  });

  it("does not attempt when there is no Google client", async () => {
    mocks.getSheetsClient.mockResolvedValue(null);
    const res = await post();
    expect(await res.text()).toBe(
      JSON.stringify({ ...attendance, autoSync: { attempted: false } }),
    );
    expect(mocks.setReviewed).not.toHaveBeenCalled();
  });

  it("resets the day to draft and reports the failure", async () => {
    mocks.executeSync.mockRejectedValue(new Error("Date row not found"));
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(
      JSON.stringify({
        ...attendance,
        autoSync: {
          attempted: true,
          success: false,
          message: "Date row not found",
        },
      }),
    );
    expect(mocks.dbSet).toHaveBeenCalledWith({
      reviewState: "draft",
      reviewedAt: null,
      updatedAt: expect.any(Date),
    });
    expect(mocks.dbWhere).toHaveBeenCalledTimes(1);
  });

  it("uses the generic message for non-Error failures", async () => {
    mocks.executeSync.mockRejectedValue("boom");
    const body = await (await post()).json();
    expect(body.autoSync).toEqual({
      attempted: true,
      success: false,
      message: "Auto-sync failed",
    });
  });

  it("returns 400 when the config lookup throws", async () => {
    mocks.getSyncConfig.mockRejectedValue(new Error("db down"));
    const res = await post();
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(JSON.stringify({ error: "db down" }));
  });

  it("returns 400 when clock-out fails", async () => {
    mocks.clockOut.mockRejectedValue(new Error("Not clocked in"));
    const res = await post();
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(JSON.stringify({ error: "Not clocked in" }));
  });
});
