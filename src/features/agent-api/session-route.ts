/** Wrapper for cookie-session agent management routes (approvals, tokens). */
import { NextResponse } from "next/server";
import { mapAgentError } from "./http";
import { requireRealSession } from "./session";

type RouteContext<P> = { params: Promise<P> };

/** Real-session guard + shared error mapping + `Cache-Control: no-store`. */
export function withRealSession<P = Record<string, never>>(
  handler: (
    session: { userId: string; timezone: string },
    req: Request,
    params: P,
  ) => Promise<Response>,
): (req: Request, routeCtx?: RouteContext<P>) => Promise<Response> {
  return async (req, routeCtx) => {
    const session = await requireRealSession();
    if (!session.ok) {
      session.response.headers.set("Cache-Control", "no-store");
      return session.response;
    }
    try {
      const params = (routeCtx ? await routeCtx.params : {}) as P;
      const res = await handler(
        { userId: session.userId, timezone: session.timezone },
        req,
        params,
      );
      res.headers.set("Cache-Control", "no-store");
      return res;
    } catch (error) {
      return mapAgentError(error);
    }
  };
}

export function jsonOk(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status });
}
