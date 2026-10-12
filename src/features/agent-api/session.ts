/** Session guard for cookie-authenticated agent management routes (Step 12). */
import { NextResponse } from "next/server";
import { auth, isAuthBypassActive } from "@/server/auth";

export type RealSession =
  | { ok: true; userId: string; timezone: string }
  | { ok: false; response: NextResponse };

export function authBypassResponse(): NextResponse {
  return NextResponse.json(
    { error: "Disabled while DISABLE_AUTH is on", code: "auth_bypass" },
    { status: 403, headers: { "Cache-Control": "no-store" } },
  );
}

/** Refuses the synthetic DISABLE_AUTH session; 401 when there is no user. */
export async function requireRealSession(): Promise<RealSession> {
  if (isAuthBypassActive()) return { ok: false, response: authBypassResponse() };
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  return { ok: true, userId, timezone: session.user.timezone };
}
