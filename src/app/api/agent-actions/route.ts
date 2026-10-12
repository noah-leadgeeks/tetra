import { z } from "zod";
import { listActions } from "@/features/agent-api/actions";
import { jsonOk, withRealSession } from "@/features/agent-api/session-route";

const querySchema = z.object({
  status: z
    .enum(["pending", "executing", "executed", "failed", "rejected", "expired"])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** GET /api/agent-actions?status=pending (session auth) */
export const GET = withRealSession(async ({ userId }, req) => {
  const url = new URL(req.url);
  const query = querySchema.parse({
    status: url.searchParams.get("status") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  return jsonOk({ actions: await listActions(userId, query) });
});
