import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  isAuthBypassActive: vi.fn(),
  approveAction: vi.fn(),
  rejectAction: vi.fn(),
  listActions: vi.fn(),
  createApiToken: vi.fn(),
  listApiTokens: vi.fn(),
  revokeApiToken: vi.fn(),
}));

vi.mock("@/server/auth", () => ({
  auth: mocks.auth,
  isAuthBypassActive: mocks.isAuthBypassActive,
}));
vi.mock("@/server/db", () => ({ db: {} }));
vi.mock("@/features/agent-api/actions", () => ({
  approveAction: mocks.approveAction,
  rejectAction: mocks.rejectAction,
  listActions: mocks.listActions,
}));
vi.mock("@/features/agent-api/tokens", async (orig) => ({
  ...(await orig<typeof import("@/features/agent-api/tokens")>()),
  createApiToken: mocks.createApiToken,
  listApiTokens: mocks.listApiTokens,
  revokeApiToken: mocks.revokeApiToken,
}));

import { GET as listGET } from "./route";
import { POST as approvePOST } from "./[id]/approve/route";
import { POST as rejectPOST } from "./[id]/reject/route";
import { GET as tokensGET, POST as tokensPOST } from "../api-tokens/route";
import { DELETE as tokenDELETE } from "../api-tokens/[id]/route";
import { BadRequestError, NotFoundError } from "@/features/agent-api/errors";

const ID = "6f1b1d0e-3c3a-4a58-9a39-0d5d2f6b8c11";
const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (body?: unknown) =>
  new Request("http://localhost/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isAuthBypassActive.mockReturnValue(false);
  mocks.auth.mockResolvedValue({ user: { id: "u1", timezone: "Asia/Jakarta" } });
});

describe("session routes: auth guard", () => {
  it("401 without a session", async () => {
    mocks.auth.mockResolvedValue(null);
    const calls = [
      await listGET(new Request("http://localhost/x")),
      await approvePOST(post({}), idCtx(ID)),
      await rejectPOST(post(), idCtx(ID)),
      await tokensGET(new Request("http://localhost/x")),
      await tokensPOST(post({ name: "a" })),
      await tokenDELETE(new Request("http://localhost/x", { method: "DELETE" }), idCtx(ID)),
    ];
    for (const res of calls) expect(res.status).toBe(401);
    expect(mocks.approveAction).not.toHaveBeenCalled();
  });

  it("403 auth_bypass under DISABLE_AUTH for approve, reject and token routes", async () => {
    mocks.isAuthBypassActive.mockReturnValue(true);
    const calls = [
      await approvePOST(post({}), idCtx(ID)),
      await rejectPOST(post(), idCtx(ID)),
      await tokensGET(new Request("http://localhost/x")),
      await tokensPOST(post({ name: "a" })),
      await tokenDELETE(new Request("http://localhost/x", { method: "DELETE" }), idCtx(ID)),
    ];
    for (const res of calls) {
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("auth_bypass");
    }
    expect(mocks.createApiToken).not.toHaveBeenCalled();
    expect(mocks.approveAction).not.toHaveBeenCalled();
  });

  it("400 Invalid id for non-uuid ids", async () => {
    const res = await approvePOST(post({}), idCtx("nope"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid id");
    expect((await rejectPOST(post(), idCtx("nope"))).status).toBe(400);
    expect(
      (await tokenDELETE(new Request("http://localhost/x", { method: "DELETE" }), idCtx("nope")))
        .status,
    ).toBe(400);
  });
});

describe("agent-actions routes", () => {
  it("lists pending actions for the session user", async () => {
    mocks.listActions.mockResolvedValue([{ id: ID }]);
    const res = await listGET(new Request("http://localhost/x?status=pending"));
    expect(res.status).toBe(200);
    expect(mocks.listActions).toHaveBeenCalledWith("u1", { status: "pending", limit: undefined });
  });

  it("approve forwards expectedFingerprint and the session user id", async () => {
    mocks.approveAction.mockResolvedValue({ id: ID, status: "executed" });
    const fp = { entryCount: 2 };
    const res = await approvePOST(post({ expectedFingerprint: fp }), idCtx(ID));
    expect(res.status).toBe(200);
    expect(mocks.approveAction).toHaveBeenCalledWith("u1", ID, { expectedFingerprint: fp });
  });

  it("another user's action maps to 404", async () => {
    mocks.approveAction.mockRejectedValue(new NotFoundError("Action not found"));
    const res = await approvePOST(post({}), idCtx(ID));
    expect(res.status).toBe(404);
    mocks.rejectAction.mockRejectedValue(new NotFoundError("Action not found"));
    expect((await rejectPOST(post(), idCtx(ID))).status).toBe(404);
    expect(mocks.rejectAction).toHaveBeenCalledWith("u1", ID);
  });
});

describe("api-tokens routes", () => {
  it("rejects unknown scopes", async () => {
    const res = await tokensPOST(post({ name: "a", scopes: ["admin"] }));
    expect(res.status).toBe(400);
    expect(mocks.createApiToken).not.toHaveBeenCalled();
  });

  it("rejects empty, blank and over-long (81 char) names with 400", async () => {
    for (const name of ["", "   ", "a".repeat(81)]) {
      const res = await tokensPOST(post({ name }));
      expect(res.status).toBe(400);
    }
    expect(mocks.createApiToken).not.toHaveBeenCalled();
    mocks.createApiToken.mockResolvedValue({ token: "tetra_x", id: ID, scopes: ["read"] });
    expect((await tokensPOST(post({ name: "a".repeat(80) }))).status).toBe(201);
  });

  it("maps a service-level BadRequestError to 400", async () => {
    mocks.createApiToken.mockRejectedValue(new BadRequestError("Token name must be 1-80 characters"));
    const res = await tokensPOST(post({ name: "ok" }));
    expect(res.status).toBe(400);
  });

  it("creates with no-store; scopes default is applied by createApiToken (read)", async () => {
    mocks.createApiToken.mockResolvedValue({ token: "tetra_x", id: ID, scopes: ["read"] });
    const res = await tokensPOST(post({ name: "bot" }));
    expect(res.status).toBe(201);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.createApiToken).toHaveBeenCalledWith("u1", { name: "bot" });
    expect((await res.json()).token).toBe("tetra_x");
  });

  it("revoke returns 404 for unknown token and 200 otherwise", async () => {
    const del = () => new Request("http://localhost/x", { method: "DELETE" });
    mocks.revokeApiToken.mockResolvedValueOnce(false);
    expect((await tokenDELETE(del(), idCtx(ID))).status).toBe(404);
    mocks.revokeApiToken.mockResolvedValueOnce(true);
    expect((await tokenDELETE(del(), idCtx(ID))).status).toBe(200);
    expect(mocks.revokeApiToken).toHaveBeenCalledWith("u1", ID);
  });
});
