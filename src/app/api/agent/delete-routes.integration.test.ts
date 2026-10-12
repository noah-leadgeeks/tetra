import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { schema } from "@/server/db";
import { seedBasics, setupTestDb, testDb } from "@/test/pglite-db";

const mocks = vi.hoisted(() => ({
  syncDaysAfterChange: vi.fn(),
  authenticateToken: vi.fn(),
}));

vi.mock("@/server/db", async () => (await import("@/test/pglite-db")).dbModuleMock());
vi.mock("@/server/auth", () => ({ isAuthBypassActive: () => false }));
vi.mock("@/features/sheets-sync/auto-sync-server", () => ({
  syncDaysAfterChange: mocks.syncDaysAfterChange,
}));
vi.mock("@/features/agent-api/tokens", async (orig) => ({
  ...(await orig<typeof import("@/features/agent-api/tokens")>()),
  authenticateToken: mocks.authenticateToken,
}));

import { approveAction } from "@/features/agent-api/actions";
import { createApiToken } from "@/features/agent-api/tokens";
import { GET as getActionRoute } from "./actions/[id]/route";
import { GET as listActionsRoute } from "./actions/route";
import { DELETE as deleteTaskRoute } from "./tasks/[id]/route";

setupTestDb();

const TZ = "Asia/Jakarta";
type Handler = (req: Request, ctx?: { params: Promise<never> }) => Promise<Response>;
const call = (handler: Handler, id: string, method: string, body?: unknown, url = "http://localhost/x") =>
  handler(
    new Request(url, {
      method,
      headers: { authorization: "Bearer tetra_x", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) as Promise<never> },
  );

let userId: string;
let categoryId: string;

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.syncDaysAfterChange.mockResolvedValue({});
  ({ userId, categoryId } = await seedBasics({ timezone: TZ }));
  const token = await createApiToken(userId, { name: "openclaw", scopes: ["read", "delete"] });
  mocks.authenticateToken.mockResolvedValue({
    userId,
    timezone: TZ,
    tokenId: token.id,
    tokenName: "openclaw",
    scopes: ["read", "delete"],
  });
});

describe("agent delete + poll (real services)", () => {
  it("DELETE keeps the task, poll shows pending, then executed after approval", async () => {
    const [task] = await testDb
      .insert(schema.tasks)
      .values({ userId, name: "Write report", categoryId })
      .returning();

    const res = await call(deleteTaskRoute as Handler, task.id, "DELETE", { reason: "dup" });
    expect(res.status).toBe(202);
    const { action } = await res.json();
    expect(action.status).toBe("pending");
    expect(action.target).toEqual({ type: "task", id: task.id, label: "Write report" });
    expect(await testDb.select().from(schema.tasks).where(eq(schema.tasks.id, task.id))).toHaveLength(1);

    let polled = await (await call(getActionRoute as Handler, action.id, "GET")).json();
    expect(polled.action.status).toBe("pending");
    expect(polled.action.stale).toBe(false);

    const listed = await (
      await call(listActionsRoute as Handler, "", "GET", undefined, "http://localhost/x?status=pending")
    ).json();
    expect(listed.actions.map((a: { id: string }) => a.id)).toEqual([action.id]);

    await approveAction(userId, action.id);

    polled = await (await call(getActionRoute as Handler, action.id, "GET")).json();
    expect(polled.action.status).toBe("executed");
    expect(polled.action.resolvedAt).not.toBeNull();
    expect(polled.action.result).toHaveProperty("needsSync");
    expect(await testDb.select().from(schema.tasks).where(eq(schema.tasks.id, task.id))).toHaveLength(0);
  });

  it("404 for another user's task, and nothing is registered", async () => {
    const other = await seedBasics({ timezone: TZ });
    const [task] = await testDb
      .insert(schema.tasks)
      .values({ userId: other.userId, name: "Theirs", categoryId })
      .returning();
    const res = await call(deleteTaskRoute as Handler, task.id, "DELETE");
    expect(res.status).toBe(404);
    expect(await testDb.select().from(schema.agentActions)).toHaveLength(0);
    expect(await testDb.select().from(schema.tasks).where(eq(schema.tasks.id, task.id))).toHaveLength(1);
  });
});
