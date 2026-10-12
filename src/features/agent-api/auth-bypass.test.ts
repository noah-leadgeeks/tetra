import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Deliberately NOT mocking `@/server/auth`: the real `isAuthBypassActive` must
// read the real `process.env.DISABLE_AUTH` and refuse agent access.
vi.mock("@/server/db", () => ({ db: {} }));
// Only the next-auth library (not loadable under vitest) is stubbed; src/server/auth.ts is real.
vi.mock("next-auth", () => ({
  default: () => ({ handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }),
}));
vi.mock("next-auth/providers/google", () => ({ default: vi.fn() }));
vi.mock("next-auth/providers/credentials", () => ({ default: vi.fn() }));

import { withAgentAuth } from "./http";
import { withRealSession } from "./session-route";

const handler = vi.fn(async () => Response.json({ ok: true }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DISABLE_AUTH", "true");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("DISABLE_AUTH=true (real env, real isAuthBypassActive)", () => {
  it("withAgentAuth answers 403 auth_bypass before looking at the token", async () => {
    const res = await withAgentAuth("read", handler)(
      new Request("http://localhost/api/agent/summary", {
        headers: { authorization: "Bearer tetra_valid" },
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "auth_bypass" });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(handler).not.toHaveBeenCalled();
  });

  it("withRealSession answers 403 auth_bypass and never runs the handler", async () => {
    const res = await withRealSession(handler)(new Request("http://localhost/api/api-tokens"));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "auth_bypass" });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(handler).not.toHaveBeenCalled();
  });
});
