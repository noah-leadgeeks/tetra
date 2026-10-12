import { NextResponse } from "next/server";
import { z } from "zod";
import { withAgentAuth } from "@/features/agent-api/http";
import { auditedWrite, parseAgentBody } from "@/features/agent-api/writes";
import { startBreak } from "@/features/attendance/service";

/** POST /api/agent/breaks/start — start a break (no sheet sync, UI parity). */
export const POST = withAgentAuth("write", async (ctx, req) => {
  await parseAgentBody(req, z.object({}));
  const attendance = await auditedWrite(
    ctx,
    { kind: "break.start", targetType: "break", summary: {} },
    () => startBreak(ctx.userId, ctx.timezone),
    (a) => ({ targetId: a.activeBreak?.id ?? null }),
  );
  return NextResponse.json({ attendance });
});
