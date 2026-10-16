import { describe, expect, it } from "vitest";
import {
  filterTodayTasks,
  MAX_DONE_ROWS,
  MAX_FOCUS_TASKS,
} from "./today-tasks-card";
import type { TaskDTO } from "@/lib/types";

function mockTask(overrides: Partial<TaskDTO> = {}): TaskDTO {
  return {
    id: "task-1",
    name: "Sample Task",
    categoryId: "cat-1",
    categoryKey: "ENG",
    categoryName: "Engineering",
    status: "todo",
    priority: "medium",
    description: null,
    isFavorite: false,
    dueAt: null,
    startedAt: null,
    completedAt: null,
    lastUsedAt: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("filterTodayTasks", () => {
  const timezone = "Asia/Jakarta";
  const todayStr = "2026-09-30";
  const dueToday = "2026-09-30T23:59:59Z";
  const overdue = "2026-09-25T23:59:59Z";

  const ids = (tasks: TaskDTO[]) => tasks.map((t) => t.id);

  it("puts the tracked task first, then worked today, then due today", () => {
    const tasks: TaskDTO[] = [
      mockTask({ id: "due", dueAt: dueToday }),
      mockTask({ id: "worked", status: "todo" }),
      mockTask({ id: "tracked", status: "in_progress" }),
    ];

    const result = filterTodayTasks(tasks, timezone, todayStr, "tracked", ["worked"]);
    expect(ids(result.focusTasks)).toEqual(["tracked", "worked", "due"]);
  });

  it("skips the tracked slot when no task is tracked or it is not found", () => {
    const tasks: TaskDTO[] = [mockTask({ id: "worked" })];

    expect(
      ids(filterTodayTasks(tasks, timezone, todayStr, null, ["worked"]).focusTasks),
    ).toEqual(["worked"]);
    expect(
      ids(filterTodayTasks(tasks, timezone, todayStr, "missing", ["worked"]).focusTasks),
    ).toEqual(["worked"]);
  });

  it("includes open worked-today tasks regardless of due date, but not done or cancelled", () => {
    const tasks: TaskDTO[] = [
      mockTask({ id: "w1", status: "backlog" }),
      mockTask({ id: "w2", status: "done", completedAt: "2026-09-20T01:00:00Z" }),
      mockTask({ id: "w3", status: "cancelled" }),
      mockTask({ id: "w4", status: "todo" }),
    ];

    const result = filterTodayTasks(tasks, timezone, todayStr, null, ["w1", "w2", "w3"]);
    expect(ids(result.focusTasks)).toEqual(["w1"]);
  });

  it("ignores favorites and unknown worked-today ids", () => {
    const tasks: TaskDTO[] = [mockTask({ id: "fav", isFavorite: true })];

    const result = filterTodayTasks(tasks, timezone, todayStr, null, ["ghost"]);
    expect(result.focusTasks).toEqual([]);
  });

  it("includes open tasks due today using the date-only key (no UTC+7 day shift)", () => {
    const tasks: TaskDTO[] = [
      mockTask({ id: "t1", dueAt: "2026-10-07T23:59:59Z" }),
      mockTask({ id: "t2", dueAt: "2026-10-06T23:59:59Z" }),
      mockTask({ id: "t3", dueAt: "2026-10-07T23:59:59Z", status: "cancelled" }),
    ];

    const result = filterTodayTasks(tasks, "Asia/Jakarta", "2026-10-07");
    expect(ids(result.focusTasks)).toEqual(["t1"]);
    expect(result.summary.overdue).toBe(1);
  });

  it("does not list plain in-progress or overdue tasks as rows", () => {
    const tasks: TaskDTO[] = [
      mockTask({ id: "ip", status: "in_progress" }),
      mockTask({ id: "od", dueAt: overdue }),
      mockTask({ id: "backlog", status: "backlog" }),
    ];

    const result = filterTodayTasks(tasks, timezone, todayStr);
    expect(result.focusTasks).toEqual([]);
    expect(result.totalCount).toBe(0);
  });

  it("deduplicates a task that is tracked, worked today and due today", () => {
    const tasks: TaskDTO[] = [
      mockTask({ id: "all", dueAt: dueToday, status: "in_progress" }),
    ];

    const result = filterTodayTasks(tasks, timezone, todayStr, "all", ["all", "all"]);
    expect(ids(result.focusTasks)).toEqual(["all"]);
  });

  it("caps open focus items at 7 and keeps the tracked task", () => {
    const tasks: TaskDTO[] = [
      ...Array.from({ length: 5 }, (_, i) => mockTask({ id: `work${i}` })),
      ...Array.from({ length: 5 }, (_, i) => mockTask({ id: `due${i}`, dueAt: dueToday })),
      mockTask({ id: "tracked", status: "in_progress" }),
    ];
    const worked = Array.from({ length: 5 }, (_, i) => `work${i}`);

    const result = filterTodayTasks(tasks, timezone, todayStr, "tracked", worked);
    expect(result.focusTasks).toHaveLength(MAX_FOCUS_TASKS);
    expect(result.focusTasks[0]?.id).toBe("tracked");
    expect(ids(result.focusTasks).slice(1)).toEqual([
      "work0", "work1", "work2", "work3", "work4", "due0",
    ]);
    // 4 due-today tasks overflow; they are neither overdue nor in progress.
    expect(result.summary).toEqual({ overdue: 0, inProgress: 0, other: 4 });
  });

  it("counts capped overflow as overdue or in progress when it qualifies", () => {
    const tasks: TaskDTO[] = [
      ...Array.from({ length: 7 }, (_, i) => mockTask({ id: `work${i}` })),
      mockTask({ id: "work-od", dueAt: overdue }),
      mockTask({ id: "work-ip", status: "in_progress" }),
      mockTask({ id: "work-plain" }),
    ];
    const worked = tasks.map((t) => t.id);

    const result = filterTodayTasks(tasks, timezone, todayStr, null, worked);
    expect(result.summary).toEqual({ overdue: 1, inProgress: 1, other: 1 });
  });

  it("limits done-today rows to 3, newest first, and reports the rest", () => {
    const done = (id: string, completedAt: string) =>
      mockTask({ id, status: "done", completedAt });
    const tasks: TaskDTO[] = [
      done("d1", "2026-09-30T01:00:00Z"),
      done("d2", "2026-09-30T05:00:00Z"),
      done("d3", "2026-09-30T03:00:00Z"),
      done("d4", "2026-09-30T04:00:00Z"),
      done("d5", "2026-09-30T02:00:00Z"),
      done("old", "2026-09-29T02:00:00Z"),
    ];

    const result = filterTodayTasks(tasks, timezone, todayStr);
    expect(result.completedTodayTasks).toHaveLength(MAX_DONE_ROWS);
    expect(ids(result.completedTodayTasks)).toEqual(["d2", "d4", "d3"]);
    expect(result.moreCompletedCount).toBe(2);
    expect(result.completedCount).toBe(5);
  });

  it("uses the zoned completion day for done tasks", () => {
    const tasks: TaskDTO[] = [
      // 2026-09-29T20:00Z is 03:00 on 09-30 in Jakarta.
      mockTask({ id: "t1", status: "done", completedAt: "2026-09-29T20:00:00Z" }),
      // 2026-09-30T20:00Z is 03:00 on 10-01 in Jakarta.
      mockTask({ id: "t2", status: "done", completedAt: "2026-09-30T20:00:00Z" }),
    ];

    const result = filterTodayTasks(tasks, timezone, todayStr);
    expect(ids(result.completedTodayTasks)).toEqual(["t1"]);
  });

  it("totals shown open items plus all completed today for the header", () => {
    const tasks: TaskDTO[] = [
      mockTask({ id: "a" }),
      mockTask({ id: "b", dueAt: dueToday }),
      ...Array.from({ length: 4 }, (_, i) =>
        mockTask({ id: `d${i}`, status: "done", completedAt: "2026-09-30T01:00:00Z" }),
      ),
      ...Array.from({ length: 50 }, (_, i) => mockTask({ id: `od${i}`, dueAt: overdue })),
    ];

    const result = filterTodayTasks(tasks, timezone, todayStr, null, ["a"]);
    expect(result.totalCount).toBe(6);
    expect(result.completedCount).toBe(4);
  });

  it("counts footer overdue and in-progress without double counting or shown rows", () => {
    const tasks: TaskDTO[] = [
      // Shown as a row, so excluded from the footer even though overdue.
      mockTask({ id: "worked-od", dueAt: overdue }),
      mockTask({ id: "od1", dueAt: overdue }),
      mockTask({ id: "od-ip", dueAt: overdue, status: "in_progress" }), // overdue only
      mockTask({ id: "ip1", status: "in_progress" }),
      mockTask({ id: "ip2", status: "in_progress" }),
      mockTask({ id: "tracked", status: "in_progress" }), // shown as a row
      mockTask({ id: "cancelled", dueAt: overdue, status: "cancelled" }),
      mockTask({ id: "done", dueAt: overdue, status: "done", completedAt: "2026-09-20T01:00:00Z" }),
      mockTask({ id: "upcoming", dueAt: "2026-10-30T23:59:59Z" }),
    ];

    const result = filterTodayTasks(tasks, timezone, todayStr, "tracked", ["worked-od"]);
    expect(ids(result.focusTasks)).toEqual(["tracked", "worked-od"]);
    expect(result.summary).toEqual({ overdue: 2, inProgress: 2, other: 0 });
  });

  it("returns empty results and zero summary when nothing qualifies", () => {
    const result = filterTodayTasks(
      [mockTask({ id: "x", status: "backlog" }), mockTask({ id: "y", dueAt: "2026-12-01T23:59:59Z" })],
      timezone,
      todayStr,
    );
    expect(result.focusTasks).toEqual([]);
    expect(result.completedTodayTasks).toEqual([]);
    expect(result.summary).toEqual({ overdue: 0, inProgress: 0, other: 0 });
  });
});
