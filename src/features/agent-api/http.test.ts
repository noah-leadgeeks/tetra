import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateToken: vi.fn(),
  insert: vi.fn(),
  isAuthBypassActive: vi.fn(),
}));

vi.mock("./tokens", async () => {
  const actual = await vi.importActual<typeof import("./tokens")>("./tokens");
  return { ...actual, authenticateToken: mocks.authenticateToken };
});
vi.mock("@/server/auth", () => ({
  auth: vi.fn(),
  isAuthBypassActive: mocks.isAuthBypassActive,
}));
vi.mock("@/server/db", () => ({ db: { insert: mocks.insert } }));

import { OverlapError } from "@/features/activities/domain";
import { BadRequestError, NotFoundError } from "./errors";
import { dayParam, parseIdParam, recordAgentAction, withAgentAuth } from "./http";

const tokenAuth = (scopes: ("read" | "write" | "delete")[]) => ({
  userId: "u1",
  timezone: "UTC",
  tokenId: "t1",
  tokenName: "n",
  scopes,
});

const req = (headers: Record<string, string> = { authorization: "Bearer tetra_abc" }) =>
  new Request("http://localhost/api/agent/x", { headers });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isAuthBypassActive.mockReturnValue(false);
  mocks.authenticateToken.mockResolvedValue(tokenAuth(["write"]));
});

describe("withAgentAuth", () => {
  const ok = async () => Response.json({ ok: true });

  it("401 without header", async () => {
    const res = await withAgentAuth("read", ok)(req({}));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized", code: "invalid_token" });
    expect(mocks.authenticateToken).not.toHaveBeenCalled();
  });

  it("401 on bad token", async () => {
    mocks.authenticateToken.mockResolvedValue(null);
    const res = await withAgentAuth("read", ok)(req());
    expect(res.status).toBe(401);
  });

  it("403 insufficient_scope for read-only token on write route", async () => {
    mocks.authenticateToken.mockResolvedValue(tokenAuth(["read"]));
    const res = await withAgentAuth("write", ok)(req());
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("insufficient_scope");
  });

  it("write token passes a read route and gets no-store", async () => {
    const res = await withAgentAuth("read", ok)(req());
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("passes awaited route params to the handler", async () => {
    const handler = vi.fn(async () => Response.json({}));
    await withAgentAuth<{ id: string }>("read", handler)(req(), {
      params: Promise.resolve({ id: "abc" }),
    });
    expect(handler).toHaveBeenCalledWith(expect.anything(), expect.anything(), { id: "abc" });
  });

  it("403 auth_bypass even with a valid token", async () => {
    mocks.isAuthBypassActive.mockReturnValue(true);
    const handler = vi.fn(ok);
    const res = await withAgentAuth("read", handler)(req());
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("auth_bypass");
    expect(handler).not.toHaveBeenCalled();
    expect(mocks.authenticateToken).not.toHaveBeenCalled();
  });

  it("maps NotFoundError, not-found messages, overlap, zod and generic errors", async () => {
    const run = (e: unknown) =>
      withAgentAuth("read", async () => {
        throw e;
      })(req());
    expect((await run(new NotFoundError("Category not found"))).status).toBe(404);
    expect((await run(new Error("Task not found"))).status).toBe(404);
    const overlap = await run(new OverlapError([{ message: "overlap" } as never]));
    expect(overlap.status).toBe(409);
    expect((await overlap.json()).details).toHaveLength(1);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const generic = await run(new Error("connect ECONNREFUSED 10.0.0.5:5432"));
    expect(generic.status).toBe(500);
    // The real message is logged, never returned.
    expect(await generic.json()).toEqual({ error: "Internal error", code: "internal_error" });
    expect(errSpy).toHaveBeenCalledWith("Agent API unexpected error", "connect ECONNREFUSED 10.0.0.5:5432");
    expect((await run("string thrown")).status).toBe(500);
    const failedTo = await run(new Error("Failed to create entry"));
    expect(failedTo.status).toBe(500);
    errSpy.mockRestore();
    // Known domain and agent-layer errors keep their message and a 400.
    const domain = await run(new Error("No active task"));
    expect(domain.status).toBe(400);
    expect(await domain.json()).toEqual({ error: "No active task", code: "bad_request" });
    expect((await run(new BadRequestError("Invalid JSON body"))).status).toBe(400);
    const { z } = await import("zod");
    const zr = z.object({ a: z.string() }).safeParse({});
    if (zr.success) throw new Error("unreachable");
    expect((await run(zr.error)).status).toBe(400);
  });
});

describe("recordAgentAction", () => {
  it("returns null and does not throw when the insert fails", async () => {
    mocks.insert.mockImplementation(() => {
      throw new Error("db down");
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const id = await recordAgentAction(tokenAuth(["write"]), {
      kind: "task.update",
      targetType: "task",
      summary: {},
    });
    expect(id).toBeNull();
    spy.mockRestore();
  });

  it("handler response is unchanged when auditing fails", async () => {
    mocks.insert.mockImplementation(() => {
      throw new Error("db down");
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await withAgentAuth("write", async (ctx) => {
      await recordAgentAction(ctx, { kind: "k", targetType: "task", summary: {} });
      return Response.json({ done: true }, { status: 201 });
    })(req());
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ done: true });
    spy.mockRestore();
  });
});

describe("parsers", () => {
  it("parseIdParam rejects non-uuid", async () => {
    const r = parseIdParam("nope");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(400);
      expect(await r.response.json()).toMatchObject({ error: "Invalid id" });
    }
    expect(parseIdParam("5b1f3c1e-8f0a-4d2b-9a55-0c1f2e3d4a5b").ok).toBe(true);
  });

  it("dayParam defaults to today in tz and rejects bad format", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T20:00:00Z"));
    expect(dayParam(new URL("http://x/a"), "Asia/Jakarta")).toBe("2026-10-13");
    expect(dayParam(new URL("http://x/a?date=2026-01-02"), "UTC")).toBe("2026-01-02");
    expect(() => dayParam(new URL("http://x/a?date=01-02-2026"), "UTC")).toThrow();
    vi.useRealTimers();
  });
});
