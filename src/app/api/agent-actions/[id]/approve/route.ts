import { z } from "zod";
import { approveAction } from "@/features/agent-api/actions";
import { parseIdParam } from "@/features/agent-api/http";
import { jsonOk, withRealSession } from "@/features/agent-api/session-route";

const bodySchema = z.object({
  expectedFingerprint: z.record(z.string(), z.unknown()).nullable().optional(),
});

/** POST /api/agent-actions/[id]/approve (session auth) */
export const POST = withRealSession<{ id: string }>(async ({ userId }, req, params) => {
  const id = parseIdParam(params.id);
  if (!id.ok) return id.response;
  const raw = await req.json().catch(() => ({}));
  const { expectedFingerprint } = bodySchema.parse(raw ?? {});
  const action = await approveAction(userId, id.id, { expectedFingerprint });
  return jsonOk({ action });
});
