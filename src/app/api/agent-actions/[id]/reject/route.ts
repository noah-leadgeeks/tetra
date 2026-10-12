import { rejectAction } from "@/features/agent-api/actions";
import { parseIdParam } from "@/features/agent-api/http";
import { jsonOk, withRealSession } from "@/features/agent-api/session-route";

/** POST /api/agent-actions/[id]/reject (session auth) */
export const POST = withRealSession<{ id: string }>(async ({ userId }, _req, params) => {
  const id = parseIdParam(params.id);
  if (!id.ok) return id.response;
  return jsonOk({ action: await rejectAction(userId, id.id) });
});
