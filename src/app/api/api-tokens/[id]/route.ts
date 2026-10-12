import { parseIdParam } from "@/features/agent-api/http";
import { NotFoundError } from "@/features/agent-api/errors";
import { jsonOk, withRealSession } from "@/features/agent-api/session-route";
import { revokeApiToken } from "@/features/agent-api/tokens";

/** DELETE /api/api-tokens/[id] (session auth): revokes the token. */
export const DELETE = withRealSession<{ id: string }>(async ({ userId }, _req, params) => {
  const id = parseIdParam(params.id);
  if (!id.ok) return id.response;
  if (!(await revokeApiToken(userId, id.id))) throw new NotFoundError("Token not found");
  return jsonOk({ ok: true });
});
