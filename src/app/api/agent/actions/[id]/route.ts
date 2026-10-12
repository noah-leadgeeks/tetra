import { NextResponse } from "next/server";
import { getAction } from "@/features/agent-api/actions";
import { parseIdParam, withAgentAuth } from "@/features/agent-api/http";

/** GET /api/agent/actions/[id] — poll an action (status, result, resolvedAt, stale). */
export const GET = withAgentAuth<{ id: string }>("read", async (ctx, _req, params) => {
  const parsed = parseIdParam(params.id);
  if (!parsed.ok) return parsed.response;
  const action = await getAction(ctx.userId, parsed.id);
  return NextResponse.json({ action });
});
