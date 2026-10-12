import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { schema } from "@/server/db";
import { seedBasics, setupTestDb, testDb } from "@/test/pglite-db";

const mocks = vi.hoisted(() => ({
  syncDaysAfterChange: vi.fn(),
  autoSyncAfterClose: vi.fn(),
  authenticateToken: vi.fn(),
}));

vi.mock("@/server/db", async () => (await import("@/test/pglite-db")).dbModuleMock());
vi.mock("@/server/auth", () => ({ isAuthBypassActive: () => false }));
vi.mock("@/features/sheets-sync/auto-sync-server", () => ({
  syncDaysAfterChange: mocks.syncDaysAfterChange,
  autoSyncAfterClose: mocks.autoSyncAfterClose,
}));
vi.mock("@/features/agent-api/tokens", async (orig) => ({
  ...(await orig<typeof import("@/features/agent-api/tokens")>()),
  authenticateToken: mocks.authenticateToken,
}));

import { recordSyncOutcome } from "@/features/agent-api/writes";
import { POST as clockInRoute } from "./attendance/clock-in/route";
import { POST as clockOutRoute } from "./attendance/clock-out/route";
import { POST as createEntryRoute } from "./time-entries/route";

setupTestDb();

const TZ = "Asia/Jakarta";
type Handler = (req: Request) => Promise<Response>;
const post = (handler: Handler, body: unknown = {}) =>
  handler(
    new Request("http://localhost/x", {
      method: "POST",
      headers: { authorization: "Bearer tetra_x", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

let userId: string;
let categoryId: string;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  ({ userId, categoryId } = await seedBasics({ timezone: TZ }));
  mocks.authenticateToken.mockResolvedValue({
    userId,
    timezone: TZ,
    tokenId: null,
    tokenName: "openclaw",
    scopes: ["read", "write"],
  });
});

const audits = () => testDb.select().from(schema.agentActions);

describe("direct agent writes persist their sheet-sync outcome on the audit row", () => {
  it("manual entry: sheetSync is merged into the executed row's result", async () => {
    const sheetSync = { "2026-10-12": { attempted: true, success: false, code: "x", message: "sheet down" } };
    mocks.syncDaysAfterChange.mockResolvedValue(sheetSync);

    const res = await post(createEntryRoute as Handler, {
      taskName: "Standup",
      categoryId,
      startedAt: "2026-10-12T09:00:00+07:00",
      endedAt: "2026-10-12T09:15:00+07:00",
    });
    expect(res.status).toBe(201);
    expect((await res.json()).sheetSync).toEqual(sheetSync);

    const [row] = await audits();
    expect(row.kind).toBe("time_entry.create");
    expect(row.status).toBe("executed");
    expect(row.result).toEqual({ sheetSync });
  });

  it("clock-in/out: autoSync is merged into each audit row", async () => {
    const clockOutSync = { attempted: true, success: true };
    mocks.autoSyncAfterClose.mockResolvedValue(clockOutSync);

    expect((await post(clockInRoute as Handler)).status).toBe(200);
    expect((await post(clockOutRoute as Handler)).status).toBe(200);

    const rows = await audits();
    const out = rows.find((r) => r.kind === "attendance.clock_out");
    expect(out?.result).toEqual({ autoSync: clockOutSync });
  });

  it("recordSyncOutcome keeps existing result keys and is a no-op without an id", async () => {
    const [row] = await testDb
      .insert(schema.agentActions)
      .values({
        userId,
        kind: "break.create",
        targetType: "break",
        summary: {},
        status: "executed",
        result: { keep: 1 },
      })
      .returning();
    await recordSyncOutcome(row.id, { sheetSync: { ok: true } });
    await recordSyncOutcome(null, { sheetSync: { ignored: true } });
    const [after] = await testDb.select().from(schema.agentActions).where(eq(schema.agentActions.id, row.id));
    expect(after.result).toEqual({ keep: 1, sheetSync: { ok: true } });
  });
});
