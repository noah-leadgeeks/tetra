import { z } from "zod";

import { sheetSafeText } from "@/lib/zod-text";
import { isoInstant } from "@/lib/zod-time";

/** Shared refine: the end must be strictly after the start. */
export function endAfterStart(data: { startedAt: string; endedAt: string }): boolean {
  return new Date(data.endedAt).getTime() > new Date(data.startedAt).getTime();
}

const endAfterStartOptions = {
  error: "End time must be after start time",
  path: ["endedAt"],
};

/** Unrefined base so agent variants can `.extend()` and re-apply the refine. */
export const manualEntryBase = z.object({
  startedAt: isoInstant,
  endedAt: isoInstant,
  taskName: z.string().trim().min(1),
  categoryId: z.uuid(),
  notes: z.string().optional(),
});

/** POST /api/time-entries body. */
export const manualEntrySchema = manualEntryBase.refine(
  endAfterStart,
  endAfterStartOptions,
);

/** Agent manual entry: category may be given by key or id. */
export const agentManualEntrySchema = manualEntryBase
  .extend({
    taskName: sheetSafeText(),
    categoryKey: z.string().optional(),
    categoryId: z.uuid().optional(),
  })
  .refine(endAfterStart, endAfterStartOptions);

/** PATCH /api/time-entries/:id body. */
export const entryPatchSchema = z.object({
  startedAt: isoInstant.optional(),
  endedAt: isoInstant.optional(),
  notes: z.string().optional(),
  categoryId: z.uuid().optional(),
  taskName: z.string().trim().min(1).optional(),
});

/** POST /api/time-entries/start body. */
export const startSchema = z.object({
  taskName: z.string().trim().min(1),
  categoryId: z.uuid(),
  notes: z.string().optional(),
});

/** Agent entry patch: category may also be given by key. */
export const agentEntryPatchSchema = entryPatchSchema.extend({
  taskName: sheetSafeText().optional(),
  categoryKey: z.string().trim().min(1).optional(),
});

/** Agent timer start: category may be given by key or id. */
export const agentStartSchema = startSchema.extend({
  taskName: sheetSafeText(),
  categoryId: z.uuid().optional(),
  categoryKey: z.string().trim().min(1).optional(),
});
