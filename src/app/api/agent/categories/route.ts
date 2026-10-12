import { NextResponse } from "next/server";
import { listCategories } from "@/features/activities/entry-queries";
import { withAgentAuth } from "@/features/agent-api/http";

/** GET /api/agent/categories */
export const GET = withAgentAuth("read", async () => {
  const categories = await listCategories();
  return NextResponse.json({
    categories: categories.map(({ id, key, name }) => ({ id, key, name })),
  });
});
