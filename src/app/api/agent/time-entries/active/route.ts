import { NextResponse } from "next/server";
import { getActiveEntry } from "@/features/activities/entry-queries";
import { withAgentAuth } from "@/features/agent-api/http";
import { toEntryItem } from "@/features/agent-api/read-models";

/** GET /api/agent/time-entries/active — the running or paused entry, or null. */
export const GET = withAgentAuth("read", async (ctx) => {
  const entry = await getActiveEntry(ctx.userId);
  return NextResponse.json({ activeEntry: entry ? toEntryItem(entry) : null });
});
