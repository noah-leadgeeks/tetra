import { z } from "zod";

import { isoInstant } from "@/lib/zod-time";

/**
 * Agent PATCH /api/agent/attendance/[date] body: the UI attendance body
 * (src/app/api/days/[date]/attendance/route.ts) with offset-required instants.
 */
export const agentAttendancePatchSchema = z.object({
  action: z.enum(["clock_in", "clock_out", "update"]).optional(),
  clockInAt: isoInstant.nullable().optional(),
  clockOutAt: isoInstant.nullable().optional(),
  status: z.enum(["open", "closed"]).optional(),
});
