import { z } from "zod";

import { isoInstant } from "@/lib/zod-time";

/** Unrefined base so variants can `.extend()` and re-apply the refine. */
export const manualBreakBase = z.object({
  workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startedAt: isoInstant,
  endedAt: isoInstant,
});

/** POST /api/breaks body. */
export const manualBreakSchema = manualBreakBase.refine(
  (data) =>
    new Date(data.endedAt).getTime() > new Date(data.startedAt).getTime(),
  {
    error: "End time must be after start time",
    path: ["endedAt"],
  },
);

/** PATCH /api/breaks/:id body. */
export const breakPatchSchema = z.object({
  startedAt: isoInstant.optional(),
  endedAt: isoInstant.optional(),
});

/** Agent manual break: same as the UI schema (instants already require an offset). */
export const agentManualBreakSchema = manualBreakSchema;
