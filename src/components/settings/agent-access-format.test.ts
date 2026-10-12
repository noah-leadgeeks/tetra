import { describe, expect, it } from "vitest";

import {
  GOOGLE_READ_ONLY_WARNING,
  describeImpact,
  formatMinutes,
  needsSyncMessage,
  summarizeResult,
} from "./agent-access-format";

describe("describeImpact", () => {
  it("task with running timer", () => {
    const d = describeImpact("task", { entryCount: 3, totalMinutes: 130, activeEntry: true });
    expect(d.lines).toEqual(["will also delete 3 entries (2h 10m)", "including the running timer"]);
  });
  it("task without timer, singular", () => {
    const d = describeImpact("task", { entryCount: 1, totalMinutes: 45, activeEntry: false });
    expect(d.lines).toEqual(["will also delete 1 entry (45m)"]);
  });
  it("calendar not linked", () => {
    const d = describeImpact("calendar_event", {
      googleLinked: false, guestCount: 2, notifiesGuests: false, canWriteGoogle: true,
    });
    expect(d).toEqual({ lines: ["not linked"], warnings: [] });
  });
  it("calendar linked, writable, guests notified", () => {
    const d = describeImpact("calendar_event", {
      googleLinked: true, guestCount: 3, notifiesGuests: true, canWriteGoogle: true,
    });
    expect(d).toEqual({ lines: ["linked to Google", "3 guests will be notified"], warnings: [] });
  });
  it("calendar linked and read-only warns", () => {
    const d = describeImpact("calendar_event", {
      googleLinked: true, guestCount: 1, notifiesGuests: true, canWriteGoogle: false,
    });
    expect(d.lines).toEqual(["linked to Google", "1 guest will be notified"]);
    expect(d.warnings).toEqual([GOOGLE_READ_ONLY_WARNING]);
  });
  it("calendar unlinked and read-only has no warning", () => {
    const d = describeImpact("calendar_event", { googleLinked: false, canWriteGoogle: false });
    expect(d.warnings).toEqual([]);
  });
  it("entry and break minutes", () => {
    expect(describeImpact("time_entry", { minutes: 90 }).lines).toEqual(["removes 1h 30m of tracked time"]);
    expect(describeImpact("break", { minutes: 15 }).lines).toEqual(["removes a 15m break"]);
  });
});

describe("result helpers", () => {
  it("formats minutes", () => expect(formatMinutes(125)).toBe("2h 5m"));
  it("summarizes failed with error", () =>
    expect(summarizeResult({ status: "failed", result: { code: "stale", error: "Target changed" } })).toBe("Target changed"));
  it("summarizes executed task with needsSync", () =>
    expect(summarizeResult({ status: "executed", result: { needsSync: ["2026-10-01"] } })).toContain("Not synced"));
  it("needsSyncMessage", () => {
    expect(needsSyncMessage([])).toBeNull();
    expect(needsSyncMessage(["2026-10-01"])).toBe("Not synced — open Timeline to sync (2026-10-01)");
  });
});
