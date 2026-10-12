import { beforeEach, describe, expect, it, vi } from "vitest";

import { NotFoundError } from "@/features/agent-api/errors";

const mocks = vi.hoisted(() => ({
  authenticateToken: vi.fn(),
  isAuthBypassActive: vi.fn(),
  requestDelete: vi.fn(),
  getAction: vi.fn(),
  listActions: vi.fn(),
  deleteTask: vi.fn(),
  deleteEntry: vi.fn(),
  deleteBreak: vi.fn(),
  deleteCalendarEvent: vi.fn(),
  syncDaysAfterChange: vi.fn(),
}));

vi.mock("@/features/agent-api/tokens", async (orig) => ({
  ...(await orig<typeof import("@/features/agent-api/tokens")>()),
  authenticateToken: mocks.authenticateToken,
}));
vi.mock("@/server/auth", () => ({ isAuthBypassActive: mocks.isAuthBypassActive }));
vi.mock("@/server/db", () => ({ db: {} }));
vi.mock("@/server/env", () => ({ env: { APP_URL: "https://tetra.example.com/" } }));
vi.mock("@/features/agent-api/actions", async (orig) => ({
  ...(await orig<typeof import("@/features/agent-api/actions")>()),
  requestDelete: mocks.requestDelete,
  getAction: mocks.getAction,
  listActions: mocks.listActions,
}));
vi.mock("@/features/activities/entry-mutations", () => ({
  deleteTask: mocks.deleteTask,
  deleteEntry: mocks.deleteEntry,
  updateTask: vi.fn(),
  updateEntry: vi.fn(),
  createTask: vi.fn(),
  createManualEntry: vi.fn(),
}));
vi.mock("@/features/attendance/service", () => ({
  deleteBreak: mocks.deleteBreak,
  updateBreak: vi.fn(),
}));
vi.mock("@/features/calendar-sync/service", () => ({
  deleteCalendarEvent: mocks.deleteCalendarEvent,
  updateCalendarEvent: vi.fn(),
  getCalendarConfig: vi.fn(),
}));
vi.mock("@/features/sheets-sync/auto-sync-server", () => ({
  syncDaysAfterChange: mocks.syncDaysAfterChange,
}));

import { DELETE as deleteBreakRoute } from "./breaks/[id]/route";
import { DELETE as deleteEventRoute } from "./calendar/events/[id]/route";
import { GET as getActionRoute } from "./actions/[id]/route";
import { GET as listActionsRoute } from "./actions/route";
import { DELETE as deleteTaskRoute } from "./tasks/[id]/route";
import { DELETE as deleteEntryRoute } from "./time-entries/[id]/route";

const TZ = "Asia/Jakarta";
const ID = "3f2b8c1e-7a4d-4e8a-9b1c-2d3e4f5a6b7c";
const ACTION_ID = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";
const auth = { authorization: "Bearer tetra_secret" };

type Handler = (req: Request, ctx?: { params: Promise<never> }) => Promise<Response>;

const call = (
  handler: Handler,
  opts: { method?: string; body?: unknown; id?: string; headers?: Record<string, string>; url?: string } = {},
) =>
  handler(
    new Request(opts.url ?? "http://localhost/api/agent/x", {
      method: opts.method ?? "DELETE",
      headers: { "content-type": "application/json", ...(opts.headers ?? auth) },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
    { params: Promise.resolve({ id: opts.id ?? ID }) as Promise<never> },
  );

const pendingAction = (over: Record<string, unknown> = {}) => ({
  id: ACTION_ID,
  kind: "task.delete",
  targetType: "task",
  targetId: ID,
  tokenId: "tok-1",
  tokenName: "openclaw",
  summary: { label: "Ship it", impact: { entryCount: 3, totalMinutes: 130 }, dayKeys: ["2026-10-10"] },
  reason: "cleanup",
  status: "pending",
  result: null,
  expiresAt: "2026-10-13T02:00:00.000Z",
  claimedAt: null,
  resolvedAt: null,
  createdAt: "2026-10-12T02:00:00.000Z",
  ...over,
});

const routes: Array<[string, Handler, string, string]> = [
  ["tasks", deleteTaskRoute, "task", "task.delete"],
  ["time-entries", deleteEntryRoute, "time_entry", "time_entry.delete"],
  ["calendar/events", deleteEventRoute, "calendar_event", "calendar_event.delete"],
  ["breaks", deleteBreakRoute, "break", "break.delete"],
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isAuthBypassActive.mockReturnValue(false);
  mocks.authenticateToken.mockResolvedValue({
    userId: "user-1",
    timezone: TZ,
    tokenId: "tok-1",
    tokenName: "openclaw",
    scopes: ["read", "delete"],
  });
});

function expectNothingDeleted() {
  expect(mocks.deleteTask).not.toHaveBeenCalled();
  expect(mocks.deleteEntry).not.toHaveBeenCalled();
  expect(mocks.deleteBreak).not.toHaveBeenCalled();
  expect(mocks.deleteCalendarEvent).not.toHaveBeenCalled();
  expect(mocks.syncDaysAfterChange).not.toHaveBeenCalled();
}

describe.each(routes)("DELETE /api/agent/%s/[id]", (_name, handler, targetType, kind) => {
  it("registers a pending action (202) and never calls a delete service", async () => {
    mocks.requestDelete.mockResolvedValue(pendingAction({ kind, targetType }));
    const res = await call(handler, { body: { reason: "cleanup", expiresInMinutes: 60 } });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.action).toEqual({
      id: ACTION_ID,
      status: "pending",
      kind,
      target: { type: targetType, id: ID, label: "Ship it" },
      impact: { entryCount: 3, totalMinutes: 130 },
      reason: "cleanup",
      createdAt: "2026-10-12T02:00:00.000Z",
      expiresAt: "2026-10-13T02:00:00.000Z",
      approvePath: "/settings/agent",
      approveUrl: "https://tetra.example.com/settings/agent",
    });
    expect(body.message).toBe("Deletion requires approval in Tetra. Poll GET /api/agent/actions/{id}.");
    expect(mocks.requestDelete).toHaveBeenCalledWith(
      { userId: "user-1", timezone: TZ, tokenId: "tok-1" },
      { targetType, targetId: ID, reason: "cleanup", expiresInMinutes: 60 },
    );
    expectNothingDeleted();
  });

  it("accepts an empty body", async () => {
    mocks.requestDelete.mockResolvedValue(pendingAction());
    const res = await call(handler);
    expect(res.status).toBe(202);
    expect(mocks.requestDelete).toHaveBeenCalledWith(expect.anything(), {
      targetType,
      targetId: ID,
      reason: null,
      expiresInMinutes: undefined,
    });
    expectNothingDeleted();
  });

  it("404 for a missing or foreign target", async () => {
    mocks.requestDelete.mockRejectedValue(new NotFoundError("Target not found"));
    const res = await call(handler);
    expect(res.status).toBe(404);
    expectNothingDeleted();
  });

  it("403 without the delete scope", async () => {
    mocks.authenticateToken.mockResolvedValue({
      userId: "user-1",
      timezone: TZ,
      tokenId: "tok-1",
      tokenName: "openclaw",
      scopes: ["read", "write"],
    });
    const res = await call(handler);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("insufficient_scope");
    expect(mocks.requestDelete).not.toHaveBeenCalled();
  });

  it("401 without a token", async () => {
    const res = await call(handler, { headers: {} });
    expect(res.status).toBe(401);
    expect(mocks.requestDelete).not.toHaveBeenCalled();
  });

  it.each([0, 1441, 1.5, "60"])("400 for invalid expiresInMinutes %s", async (v) => {
    const res = await call(handler, { body: { expiresInMinutes: v } });
    expect(res.status).toBe(400);
    expect(mocks.requestDelete).not.toHaveBeenCalled();
  });

  it("400 for an over-long reason and a non-uuid id", async () => {
    expect((await call(handler, { body: { reason: "x".repeat(501) } })).status).toBe(400);
    expect((await call(handler, { id: "nope" })).status).toBe(400);
    expect(mocks.requestDelete).not.toHaveBeenCalled();
  });

  it("403 auth_bypass under DISABLE_AUTH", async () => {
    mocks.isAuthBypassActive.mockReturnValue(true);
    const res = await call(handler);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("auth_bypass");
    expect(mocks.requestDelete).not.toHaveBeenCalled();
  });
});

describe("GET /api/agent/actions/[id]", () => {
  it("returns the action scoped to the token user", async () => {
    mocks.getAction.mockResolvedValue(pendingAction({ stale: false }));
    const res = await call(getActionRoute, { method: "GET", id: ACTION_ID });
    expect(res.status).toBe(200);
    expect((await res.json()).action.status).toBe("pending");
    expect(mocks.getAction).toHaveBeenCalledWith("user-1", ACTION_ID);
  });

  it("404 for unknown, 400 for non-uuid, 401 without token", async () => {
    mocks.getAction.mockRejectedValue(new NotFoundError("Action not found"));
    expect((await call(getActionRoute, { method: "GET", id: ACTION_ID })).status).toBe(404);
    expect((await call(getActionRoute, { method: "GET", id: "x" })).status).toBe(400);
    expect((await call(getActionRoute, { method: "GET", headers: {} })).status).toBe(401);
  });
});

describe("GET /api/agent/actions", () => {
  it("lists with status and limit", async () => {
    mocks.listActions.mockResolvedValue([pendingAction()]);
    const res = await call(listActionsRoute, {
      method: "GET",
      url: "http://localhost/api/agent/actions?status=pending&limit=5",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).actions).toHaveLength(1);
    expect(mocks.listActions).toHaveBeenCalledWith("user-1", { status: "pending", limit: 5 });
  });

  it("400 for an unknown status", async () => {
    const res = await call(listActionsRoute, {
      method: "GET",
      url: "http://localhost/api/agent/actions?status=bogus",
    });
    expect(res.status).toBe(400);
    expect(mocks.listActions).not.toHaveBeenCalled();
  });
});
