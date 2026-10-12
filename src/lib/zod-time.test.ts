import { describe, expect, it } from "vitest";

import { agentCreateTaskSchema, agentUpdateTaskSchema, createTaskSchema, updateTaskSchema } from "@/features/activities/task-schemas";
import {
  agentEntryPatchSchema,
  agentManualEntrySchema,
  agentStartSchema,
  manualEntrySchema,
  startSchema,
} from "@/features/activities/entry-schemas";
import { manualBreakSchema, breakPatchSchema } from "@/features/attendance/break-schemas";
import { agentCreateEventSchema, agentUpdateEventSchema, createEventSchema } from "@/features/calendar-sync/event-schemas";
import { dueAtFromDate, isoInstant } from "./zod-time";

const Z = "2026-10-12T09:00:00Z";
const OFF = "2026-10-12T09:00:00+07:00";
const NAIVE = "2026-10-12T09:00:00";
const END_Z = "2026-10-12T10:00:00Z";
const cat = "0b6f1a4e-6b4e-4f6a-8d5e-2d3c1a9b7c10";

describe("isoInstant / dueAtFromDate", () => {
  it("requires an offset", () => {
    expect(isoInstant.safeParse(Z).success).toBe(true);
    expect(isoInstant.safeParse(OFF).success).toBe(true);
    expect(isoInstant.safeParse(NAIVE).success).toBe(false);
  });
  it("builds the due-date storage string", () => {
    expect(dueAtFromDate("2026-10-20")).toBe("2026-10-20T23:59:59Z");
  });
});

describe("entry schemas", () => {
  const base = { taskName: "x", categoryId: cat };
  for (const [name, schema] of [["manual", manualEntrySchema], ["agent", agentManualEntrySchema]] as const) {
    it(`${name}: offsets accepted, naive rejected, end<=start rejected`, () => {
      expect(schema.safeParse({ ...base, startedAt: Z, endedAt: END_Z }).success).toBe(true);
      expect(schema.safeParse({ ...base, startedAt: OFF, endedAt: END_Z }).success).toBe(true);
      expect(schema.safeParse({ ...base, startedAt: NAIVE, endedAt: END_Z }).success).toBe(false);
      expect(schema.safeParse({ ...base, startedAt: END_Z, endedAt: Z }).success).toBe(false);
      expect(schema.safeParse({ ...base, startedAt: Z, endedAt: Z }).success).toBe(false);
    });
  }
  it("agent entry accepts categoryKey without categoryId", () => {
    expect(agentManualEntrySchema.safeParse({ taskName: "x", categoryKey: "dev", startedAt: Z, endedAt: END_Z }).success).toBe(true);
  });
});

describe("break schemas", () => {
  const base = { workDate: "2026-10-12" };
  it("manual break", () => {
    expect(manualBreakSchema.safeParse({ ...base, startedAt: OFF, endedAt: END_Z }).success).toBe(true);
    expect(manualBreakSchema.safeParse({ ...base, startedAt: NAIVE, endedAt: END_Z }).success).toBe(false);
    expect(manualBreakSchema.safeParse({ ...base, startedAt: END_Z, endedAt: Z }).success).toBe(false);
  });
  it("break patch", () => {
    expect(breakPatchSchema.safeParse({ startedAt: Z }).success).toBe(true);
    expect(breakPatchSchema.safeParse({ endedAt: NAIVE }).success).toBe(false);
  });
});

describe("event schemas", () => {
  const base = { title: "Standup" };
  it("agent create requires offsets; UI schema keeps loose strings", () => {
    expect(agentCreateEventSchema.safeParse({ ...base, startAt: Z, endAt: OFF }).success).toBe(true);
    expect(agentCreateEventSchema.safeParse({ ...base, startAt: NAIVE, endAt: END_Z }).success).toBe(false);
    expect(createEventSchema.safeParse({ ...base, startAt: NAIVE, endAt: "x" }).success).toBe(true);
  });
  it("agent update", () => {
    expect(agentUpdateEventSchema.safeParse({ startAt: OFF }).success).toBe(true);
    expect(agentUpdateEventSchema.safeParse({ endAt: NAIVE }).success).toBe(false);
    expect(agentUpdateEventSchema.safeParse({}).success).toBe(true);
  });
});

describe("agent task schemas", () => {
  const base = { name: "t", categoryId: cat };
  it("accept dueDate, reject dueAt", () => {
    expect(agentCreateTaskSchema.safeParse({ ...base, dueDate: "2026-10-20" }).success).toBe(true);
    expect(agentCreateTaskSchema.safeParse({ ...base, dueAt: "2026-10-20T00:00:00Z" }).success).toBe(false);
    expect(agentUpdateTaskSchema.safeParse({ dueDate: null }).success).toBe(true);
    expect(agentUpdateTaskSchema.safeParse({ dueAt: "2026-10-20T00:00:00Z" }).success).toBe(false);
    expect(agentCreateTaskSchema.safeParse({ ...base, dueDate: "2026-10-20T00:00:00Z" }).success).toBe(false);
  });
});

describe("agent task timestamps", () => {
  it("startedAt/completedAt require an offset; null clears; absent stays undefined", () => {
    expect(agentUpdateTaskSchema.safeParse({ startedAt: NAIVE }).success).toBe(false);
    expect(agentUpdateTaskSchema.safeParse({ completedAt: NAIVE }).success).toBe(false);
    const ok = agentUpdateTaskSchema.safeParse({ startedAt: OFF, completedAt: null });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.startedAt).toEqual(new Date(OFF));
      expect(ok.data.completedAt).toBeNull();
    }
    const empty = agentUpdateTaskSchema.safeParse({});
    expect(empty.success && "startedAt" in empty.data && empty.data.startedAt).toBeFalsy();
    // UI schema is unchanged.
    expect(updateTaskSchema.safeParse({ startedAt: NAIVE }).success).toBe(true);
  });
});

describe("agent free-text fields reject spreadsheet formula prefixes", () => {
  const bad = ["=SUM(A1)", "+1", "-1", "@cmd", "\t=1", "\r=1", "  =1+1", "\n=1"];
  const ok = ["Review PR", "a=b", "Fix -1 bug", "x@y"];

  it("task name (create + update)", () => {
    for (const name of bad) {
      expect(agentCreateTaskSchema.safeParse({ name, categoryId: cat }).success, name).toBe(false);
      expect(agentUpdateTaskSchema.safeParse({ name }).success, name).toBe(false);
    }
    for (const name of ok) {
      expect(agentCreateTaskSchema.safeParse({ name, categoryId: cat }).success, name).toBe(true);
      expect(agentUpdateTaskSchema.safeParse({ name }).success, name).toBe(true);
    }
  });

  it("taskName (manual entry, patch, start)", () => {
    for (const taskName of bad) {
      expect(agentManualEntrySchema.safeParse({ taskName, categoryId: cat, startedAt: Z, endedAt: END_Z }).success, taskName).toBe(false);
      expect(agentEntryPatchSchema.safeParse({ taskName }).success, taskName).toBe(false);
      expect(agentStartSchema.safeParse({ taskName, categoryId: cat }).success, taskName).toBe(false);
    }
    for (const taskName of ok) {
      expect(agentManualEntrySchema.safeParse({ taskName, categoryId: cat, startedAt: Z, endedAt: END_Z }).success, taskName).toBe(true);
      expect(agentEntryPatchSchema.safeParse({ taskName }).success, taskName).toBe(true);
      expect(agentStartSchema.safeParse({ taskName, categoryId: cat }).success, taskName).toBe(true);
    }
  });

  it("UI schemas are unchanged", () => {
    expect(createTaskSchema.safeParse({ name: "=1", categoryId: cat }).success).toBe(true);
    expect(startSchema.safeParse({ taskName: "-x", categoryId: cat }).success).toBe(true);
    expect(manualEntrySchema.safeParse({ taskName: "+x", categoryId: cat, startedAt: Z, endedAt: END_Z }).success).toBe(true);
  });
});
