import { NextResponse } from "next/server";
import { z } from "zod";

import { env } from "@/server/env";
import {
  MAX_AGENT_ACTION_TTL_MINUTES,
  requestDelete,
  type AgentActionDTO,
  type DeletableTargetType,
} from "./actions";
import { parseIdParam, withAgentAuth } from "./http";
import { parseAgentBody } from "./writes";

export const AGENT_APPROVE_PATH = "/settings/agent";

export const agentDeleteBodySchema = z.object({
  reason: z.string().max(500).nullish(),
  expiresInMinutes: z.number().int().min(1).max(MAX_AGENT_ACTION_TTL_MINUTES).optional(),
});

/** Public shape of a pending action returned by the delete endpoints (202). */
export function toPendingActionResponse(action: AgentActionDTO) {
  const label = typeof action.summary.label === "string" ? action.summary.label : "";
  return {
    id: action.id,
    status: action.status,
    kind: action.kind,
    target: { type: action.targetType, id: action.targetId, label },
    impact: action.summary.impact ?? {},
    reason: action.reason,
    createdAt: action.createdAt,
    expiresAt: action.expiresAt,
    approvePath: AGENT_APPROVE_PATH,
    approveUrl: `${env.APP_URL.replace(/\/+$/, "")}${AGENT_APPROVE_PATH}`,
  };
}

/**
 * Builds a `DELETE /api/agent/<resource>/[id]` handler (scope `delete`). It only
 * registers a pending action for in-app approval; nothing is deleted here.
 */
export function agentDeleteHandler(targetType: DeletableTargetType) {
  return withAgentAuth<{ id: string }>("delete", async (ctx, req, params) => {
    const parsed = parseIdParam(params.id);
    if (!parsed.ok) return parsed.response;
    const body = await parseAgentBody(req, agentDeleteBodySchema);

    const action = await requestDelete(
      { userId: ctx.userId, timezone: ctx.timezone, tokenId: ctx.tokenId },
      {
        targetType,
        targetId: parsed.id,
        reason: body.reason ?? null,
        expiresInMinutes: body.expiresInMinutes,
      },
    );
    return NextResponse.json(
      {
        action: toPendingActionResponse(action),
        message: "Deletion requires approval in Tetra. Poll GET /api/agent/actions/{id}.",
      },
      { status: 202 },
    );
  });
}
