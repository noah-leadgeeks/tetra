import { NextResponse } from "next/server";
import { z } from "zod";
import { listActions } from "@/features/agent-api/actions";
import { withAgentAuth } from "@/features/agent-api/http";

const querySchema = z.object({
  status: z.enum(["pending", "executing", "executed", "failed", "rejected", "expired"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** GET /api/agent/actions?status=&limit= — the token owner's agent actions (newest first). */
export const GET = withAgentAuth("read", async (ctx, req) => {
  const url = new URL(req.url);
  const query = querySchema.parse({
    status: url.searchParams.get("status") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  const actions = await listActions(ctx.userId, query);
  return NextResponse.json({ actions });
});
