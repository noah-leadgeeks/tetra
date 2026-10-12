import { afterEach, describe, expect, it, vi } from "vitest";

import { todayKey, zonedDayKey } from "@/lib/time";
import type { TaskDTO } from "@/lib/types";
import { dueDateKey, filterTasks, isDueToday, isOverdue } from "./task-dates";

describe("task-dates", () => {
  const dueAt = "2026-10-07T23:59:59Z";

  it("dueDateKey takes the date part", () => {
    expect(dueDateKey(dueAt)).toBe("2026-10-07");
  });

  it("is due today (not overdue) on the due date in UTC+7", () => {
    // 2026-10-07 20:00 UTC is 2026-10-08 03:00 in Jakarta; use an instant on the 7th locally.
    const today = zonedDayKey(new Date("2026-10-07T05:00:00Z"), "Asia/Jakarta");
    expect(today).toBe("2026-10-07");
    expect(isDueToday(dueAt, today)).toBe(true);
    expect(isOverdue(dueAt, "todo", today)).toBe(false);
  });

  it("is overdue the next day in UTC+7", () => {
    const today = zonedDayKey(new Date("2026-10-08T05:00:00Z"), "Asia/Jakarta");
    expect(today).toBe("2026-10-08");
    expect(isOverdue(dueAt, "todo", today)).toBe(true);
    expect(isDueToday(dueAt, today)).toBe(false);
  });

  it("never reports done/cancelled/no-due tasks as overdue", () => {
    expect(isOverdue(dueAt, "done", "2026-10-09")).toBe(false);
    expect(isOverdue(dueAt, "cancelled", "2026-10-09")).toBe(false);
    expect(isOverdue(null, "todo", "2026-10-09")).toBe(false);
  });
});

function task(over: Partial<TaskDTO> & { name: string }): TaskDTO {
  return {
    id: over.name,
    categoryId: "c",
    status: "todo",
    isFavorite: false,
    lastUsedAt: null,
    ...over,
  };
}

describe("filterTasks", () => {
  afterEach(() => vi.useRealTimers());

  const today = "2026-10-12";
  const tasks = [
    task({ name: "late", dueAt: "2026-10-10T23:59:59Z" }),
    task({ name: "now", dueAt: "2026-10-12T23:59:59Z", priority: "high" }),
    task({ name: "soon", dueAt: "2026-10-15T23:59:59Z" }),
    task({ name: "edge", dueAt: "2026-10-19T23:59:59Z" }),
    task({ name: "far", dueAt: "2026-10-20T23:59:59Z" }),
    task({ name: "doing", status: "in_progress", priority: "urgent" }),
    task({ name: "finished", status: "done", dueAt: "2026-10-14T23:59:59Z" }),
    task({ name: "dropped", status: "cancelled", dueAt: "2026-10-14T23:59:59Z" }),
  ];
  const names = (f: Parameters<typeof filterTasks>[1]) =>
    filterTasks(tasks, f, today).map((t) => t.name);

  it("today / overdue / in_progress", () => {
    expect(names("today")).toEqual(["now"]);
    expect(names("overdue")).toEqual(["late"]);
    expect(names("in_progress")).toEqual(["doing"]);
  });

  it("upcoming is (today, today+7] and excludes done/cancelled", () => {
    expect(names("upcoming")).toEqual(["soon", "edge"]);
    expect(filterTasks(tasks, "upcoming", today, 3).map((t) => t.name)).toEqual(["soon"]);
  });

  it("open excludes done/cancelled; all keeps everything", () => {
    expect(names("open")).not.toContain("finished");
    expect(names("open")).not.toContain("dropped");
    expect(names("all")).toHaveLength(tasks.length);
  });

  it("sorts by priority, then due date, then name", () => {
    expect(names("open")).toEqual(["doing", "now", "late", "soon", "edge", "far"]);
    const same = [
      task({ name: "b", dueAt: "2026-10-13T23:59:59Z" }),
      task({ name: "a", dueAt: "2026-10-13T23:59:59Z" }),
      task({ name: "c", dueAt: "2026-10-12T23:59:59Z" }),
    ];
    expect(filterTasks(same, "all", today).map((t) => t.name)).toEqual(["c", "a", "b"]);
  });

  it("does not mutate the input array", () => {
    const copy = [...tasks];
    filterTasks(tasks, "all", today);
    expect(tasks).toEqual(copy);
  });

  it("same task is overdue in Jakarta but due today in UTC", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T20:00:00Z"));
    const t = task({ name: "tz", dueAt: "2026-10-12T23:59:59Z" });

    const jakarta = todayKey("Asia/Jakarta");
    expect(jakarta).toBe("2026-10-13");
    expect(filterTasks([t], "overdue", jakarta)).toHaveLength(1);
    expect(filterTasks([t], "today", jakarta)).toHaveLength(0);

    const utc = todayKey("UTC");
    expect(utc).toBe("2026-10-12");
    expect(filterTasks([t], "today", utc)).toHaveLength(1);
    expect(filterTasks([t], "overdue", utc)).toHaveLength(0);
  });
});
