import { z } from "zod";
import { AGENT_SCOPES, createApiToken, listApiTokens } from "@/features/agent-api/tokens";
import { jsonOk, withRealSession } from "@/features/agent-api/session-route";

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(z.enum(AGENT_SCOPES)).min(1).optional(),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});

/** GET /api/api-tokens (session auth) */
export const GET = withRealSession(async ({ userId }) => {
  return jsonOk({ tokens: await listApiTokens(userId) });
});

/** POST /api/api-tokens: returns the plaintext token exactly once. */
export const POST = withRealSession(async ({ userId }, req) => {
  const body = createSchema.parse(await req.json().catch(() => ({})));
  const created = await createApiToken(userId, body);
  return jsonOk(created, 201);
});
