import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ listActions: vi.fn() }));

vi.mock("@/server/db", () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [{ timezone: "Asia/Jakarta" }] }) }),
    }),
  },
}));
vi.mock("@/features/daily-summary/service", () => ({
  getDaySummary: vi.fn().mockRejectedValue(new Error("boom")),
}));
vi.mock("@/features/weekly-summary/service", () => ({
  getWeekSummary: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/features/calendar-sync/service", () => ({
  getCalendarSchedule: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/features/agent-api/actions", () => ({ listActions: mocks.listActions }));

import { getCompanionAlerts } from "./service";

describe("getCompanionAlerts agent approvals", () => {
  it("emits the approval alert even when daySummary is unavailable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.listActions.mockResolvedValue([
      {
        id: "x1",
        status: "pending",
        reason: null,
        expiresAt: null,
        summary: { label: "Task A" },
        live: null,
      },
    ]);
    const alerts = await getCompanionAlerts("u1");
    expect(mocks.listActions).toHaveBeenCalledWith("u1", { status: "pending" });
    expect(alerts.map((a) => a.id)).toEqual(["alert-agent-action-x1"]);
  });

  it("returns [] when both summary and actions fail", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.listActions.mockRejectedValue(new Error("db"));
    expect(await getCompanionAlerts("u1")).toEqual([]);
  });
});
