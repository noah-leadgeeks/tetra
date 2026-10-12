import { expect, test, type APIRequestContext } from "@playwright/test";
import { login } from "./helpers";

// Agent API end to end: token from Settings -> bearer reads/writes -> delete
// request -> bell alert -> in-app approval -> poll -> revoke. Runs against the
// fresh PGlite server from playwright.config.ts (Google env blanked), so the
// calendar endpoints are local-only.

const TIME_ZONE = process.env.DEFAULT_TIMEZONE ?? "Asia/Jakarta";
const TASK_NAME = `E2E Agent Task ${Date.now().toString(36)}`;

function todayInZone(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(new Date());
}

// Agent access refuses to run under the auth bypass; fail fast instead of
// producing confusing 403s further down.
test.beforeAll(() => {
  expect(process.env.DISABLE_AUTH, "DISABLE_AUTH must be unset for e2e").toBeFalsy();
  expect(process.env.NEXT_PUBLIC_DISABLE_AUTH, "NEXT_PUBLIC_DISABLE_AUTH must be unset for e2e").toBeFalsy();
});

test("agent API: token, read, write, delete approval, revoke", async ({ page, playwright, baseURL }) => {
  await login(page);

  // --- Create a write + delete token in Settings -> Agent access ------------
  await page.goto("/settings/agent");
  // Wait for the token list to load so the page is hydrated (dev compiles lazily).
  await expect(page.getByText("No tokens yet.")).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("agent-token-create").click();
  await page.getByTestId("agent-token-name").fill("E2E OpenClaw");
  await page.getByTestId("agent-token-scope-write").check();
  await page.getByTestId("agent-token-scope-delete").check();
  await page.getByRole("button", { name: "Create token" }).click();
  const plaintextEl = page.getByTestId("agent-token-plaintext");
  await expect(plaintextEl).toBeVisible({ timeout: 60_000 });
  const token = (await plaintextEl.textContent())?.trim() ?? "";
  expect(token).toMatch(/^tetra_[A-Za-z0-9_-]+$/);
  await page.getByRole("button", { name: "Done" }).click();

  // A separate request context carries only the bearer token, never the
  // browser's session cookie, so these calls prove bearer auth on its own.
  const agent: APIRequestContext = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
  const anonymous = await playwright.request.newContext({ baseURL });

  try {
    expect((await anonymous.get("/api/agent/summary")).status()).toBe(401);

    // --- Reads ---------------------------------------------------------------
    const summaryRes = await agent.get("/api/agent/summary");
    expect(summaryRes.status()).toBe(200);
    expect(summaryRes.headers()["cache-control"]).toContain("no-store");
    const summary = (await summaryRes.json()) as { date: string; timezone: string };
    expect(summary.timezone).toBe(TIME_ZONE);
    expect(summary.date).toBe(todayInZone());

    // --- Create a task (direct write) ----------------------------------------
    const createRes = await agent.post("/api/agent/tasks", {
      data: { name: TASK_NAME, categoryKey: "other_tasks", dueDate: todayInZone() },
    });
    expect(createRes.status(), await createRes.text()).toBe(201);
    const { task } = (await createRes.json()) as { task: { id: string; name: string; dueDate: string } };
    expect(task.name).toBe(TASK_NAME);
    expect(task.dueDate).toBe(todayInZone());

    // Agent timestamps must carry an offset; `dueAt` is not accepted.
    const badTask = await agent.post("/api/agent/tasks", {
      data: { name: "x", categoryKey: "other_tasks", dueAt: "2026-10-20T23:59:59Z" },
    });
    expect(badTask.status()).toBe(400);

    // --- Calendar: local-only in e2e (no Google link) -------------------------
    const day = todayInZone();
    const eventRes = await agent.post("/api/agent/calendar/events", {
      data: { title: "E2E agent event", startAt: `${day}T09:00:00+07:00`, endAt: `${day}T09:30:00+07:00` },
    });
    expect(eventRes.status(), await eventRes.text()).toBe(201);
    const created = (await eventRes.json()) as {
      event: { id: string };
      google: { synced: boolean; error: string | null };
    };
    expect(created.google).toEqual({ synced: false, error: "not_linked" });

    const patchEvent = await agent.patch(`/api/agent/calendar/events/${created.event.id}`, {
      data: { title: "E2E agent event (moved)" },
    });
    expect(patchEvent.status(), await patchEvent.text()).toBe(200);
    expect(((await patchEvent.json()) as { google: unknown }).google).toEqual({
      synced: false,
      error: "not_linked",
    });

    const naiveEvent = await agent.post("/api/agent/calendar/events", {
      data: { title: "naive", startAt: `${day}T09:00:00`, endAt: `${day}T09:30:00` },
    });
    expect(naiveEvent.status()).toBe(400);

    // --- Delete request: 202, nothing deleted yet ------------------------------
    const delRes = await agent.delete(`/api/agent/tasks/${task.id}`, {
      data: { reason: "Duplicate created by the e2e run" },
    });
    expect(delRes.status(), await delRes.text()).toBe(202);
    const { action } = (await delRes.json()) as {
      action: { id: string; status: string; approvePath: string; target: { label: string } };
    };
    expect(action.status).toBe("pending");
    expect(action.approvePath).toBe("/settings/agent");
    expect(action.target.label).toBe(TASK_NAME);

    expect((await agent.get(`/api/agent/tasks/${task.id}`)).status()).toBe(200);
    const uiTasks = (await (await page.request.get("/api/tasks")).json()) as { id: string }[];
    expect(uiTasks.some((t) => t.id === task.id), "task still exists before approval").toBe(true);

    // --- Bell: opening the menu refreshes alerts ------------------------------
    await page.goto("/");
    await page.getByTestId("notifications-trigger").click();
    const panel = page.getByTestId("notifications-panel");
    await expect(panel).toContainText(`Agent wants to delete ${TASK_NAME}`, { timeout: 15_000 });
    await page.keyboard.press("Escape");

    // --- Approve on /settings/agent ------------------------------------------
    await page.goto("/settings/agent");
    const approve = page.getByTestId(`agent-action-approve-${action.id}`);
    await expect(approve).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`agent-action-stale-${action.id}`)).toHaveCount(0);
    const approveReq = page.waitForRequest(
      (r) => r.url().endsWith(`/api/agent-actions/${action.id}/approve`) && r.method() === "POST",
    );
    await approve.click();
    const sent = (await approveReq).postDataJSON() as { expectedFingerprint: unknown };
    expect(sent.expectedFingerprint).toMatchObject({ name: TASK_NAME });
    await expect(approve).toHaveCount(0, { timeout: 15_000 });

    // --- Poll: executed, task gone --------------------------------------------
    await expect
      .poll(
        async () => {
          const res = await agent.get(`/api/agent/actions/${action.id}`);
          return ((await res.json()) as { action: { status: string } }).action.status;
        },
        { timeout: 15_000 },
      )
      .toBe("executed");
    expect((await agent.get(`/api/agent/tasks/${task.id}`)).status()).toBe(404);
    const afterTasks = (await (await page.request.get("/api/tasks")).json()) as { id: string }[];
    expect(afterTasks.some((t) => t.id === task.id), "task deleted after approval").toBe(false);

    // --- Revoke: the next bearer call is 401 -----------------------------------
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: "Revoke" }).first().click();
    await expect(page.getByText("Revoked", { exact: true })).toBeVisible({ timeout: 10_000 });

    const revoked = await agent.get("/api/agent/summary");
    expect(revoked.status()).toBe(401);
    expect(((await revoked.json()) as { code: string }).code).toBe("invalid_token");
  } finally {
    await agent.dispose();
    await anonymous.dispose();
  }
});
