import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dismissAlerts,
  sendBrowserAlert,
  syncCompanionAlerts,
} from "./store";
import type { TetraNotification } from "./types";

describe("Notifications Store & Browser Alerts", () => {
  const originalNotification = globalThis.Notification;
  const originalNavigator = globalThis.navigator;
  const originalWindow = globalThis.window;
  const originalLocalStorage = globalThis.localStorage;

  const storageMap = new Map<string, string>();
  const mockLocalStorage = {
    getItem: (key: string) => storageMap.get(key) ?? null,
    setItem: (key: string, val: string) => storageMap.set(key, String(val)),
    removeItem: (key: string) => storageMap.delete(key),
    clear: () => storageMap.clear(),
    key: (i: number) => Array.from(storageMap.keys())[i] ?? null,
    length: 0,
  };

  beforeEach(() => {
    storageMap.clear();
    Object.defineProperty(globalThis, "window", {
      value: globalThis,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, "localStorage", {
      value: mockLocalStorage,
      writable: true,
      configurable: true,
    });
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.Notification = originalNotification;
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, "window", {
      value: originalWindow,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, "localStorage", {
      value: originalLocalStorage,
      writable: true,
      configurable: true,
    });
  });

  it("safely handles sendBrowserAlert when Notification API is unsupported", () => {
    // @ts-expect-error simulating missing API
    delete globalThis.Notification;
    expect(() => sendBrowserAlert("Test", "Message")).not.toThrow();
  });

  it("does not trigger notification when permission is default or denied", () => {
    const mockConstructor = vi.fn();
    // @ts-expect-error mock Notification
    globalThis.Notification = mockConstructor;
    // @ts-expect-error mock permission
    globalThis.Notification.permission = "denied";

    sendBrowserAlert("Test", "Message");
    expect(mockConstructor).not.toHaveBeenCalled();
  });

  it("triggers new Notification when permission is granted and no service worker", () => {
    const mockConstructor = vi.fn();
    // @ts-expect-error mock Notification
    globalThis.Notification = mockConstructor;
    // @ts-expect-error mock permission
    globalThis.Notification.permission = "granted";

    Object.defineProperty(globalThis, "navigator", {
      value: {},
      writable: true,
      configurable: true,
    });

    sendBrowserAlert("Hello", "World", "/timer");
    expect(mockConstructor).toHaveBeenCalledWith("TETRA · Hello", {
      body: "World",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: "/timer" },
      tag: expect.stringContaining("tetra-alert-"),
    });
  });

  it("routes notification through service worker registration when available", async () => {
    const showNotificationMock = vi.fn().mockResolvedValue(undefined);
    // @ts-expect-error mock Notification
    globalThis.Notification = vi.fn();
    // @ts-expect-error mock permission
    globalThis.Notification.permission = "granted";

    Object.defineProperty(globalThis, "navigator", {
      value: {
        serviceWorker: {
          ready: Promise.resolve({
            showNotification: showNotificationMock,
          }),
        },
      },
      writable: true,
      configurable: true,
    });

    sendBrowserAlert("PWA Alert", "Running via Service Worker", "/settings");

    await vi.waitFor(() => {
      expect(showNotificationMock).toHaveBeenCalledWith(
        "TETRA · PWA Alert",
        expect.objectContaining({
          body: "Running via Service Worker",
          data: { url: "/settings" },
        }),
      );
    });
  });

  it("dispatches browser alert when syncCompanionAlerts finds newly surfaced warning alerts", () => {
    const mockConstructor = vi.fn();
    // @ts-expect-error mock Notification
    globalThis.Notification = mockConstructor;
    // @ts-expect-error mock permission
    globalThis.Notification.permission = "granted";
    mockLocalStorage.setItem("tetra_browser_notifications_v1", "true");

    Object.defineProperty(globalThis, "navigator", {
      value: {},
      writable: true,
      configurable: true,
    });

    const alerts: TetraNotification[] = [
      {
        id: "alert-gap-1",
        type: "gap",
        severity: "warning",
        title: "Time Gap Detected",
        message: "You have 45m unlogged",
        timestamp: new Date().toISOString(),
        read: false,
        href: "/timeline",
      },
    ];

    syncCompanionAlerts(alerts);

    expect(mockConstructor).toHaveBeenCalledWith(
      "TETRA · Time Gap Detected",
      expect.objectContaining({
        body: "You have 45m unlogged",
      }),
    );
  });
  const makeAlert = (
    id: string,
    type: string,
    severity: TetraNotification["severity"] = "warning",
  ): TetraNotification => ({
    id,
    type: type as TetraNotification["type"],
    severity,
    title: `Title ${id}`,
    message: `Message ${id}`,
    timestamp: new Date().toISOString(),
    read: false,
    href: "/timeline",
  });

  const enableBrowserAlerts = () => {
    const mockConstructor = vi.fn();
    // @ts-expect-error mock Notification
    globalThis.Notification = mockConstructor;
    // @ts-expect-error mock permission
    globalThis.Notification.permission = "granted";
    mockLocalStorage.setItem("tetra_browser_notifications_v1", "true");
    Object.defineProperty(globalThis, "navigator", {
      value: {},
      writable: true,
      configurable: true,
    });
    return mockConstructor;
  };

  const storedIds = () =>
    JSON.parse(mockLocalStorage.getItem("tetra_notifications_v1") ?? "[]").map(
      (n: TetraNotification) => n.id,
    );

  it("keeps a dismissed alert absent across later syncs", () => {
    const alert = makeAlert("alert-dismiss-1", "gap");
    syncCompanionAlerts([alert]);
    expect(storedIds()).toContain("alert-dismiss-1");

    dismissAlerts(["alert-dismiss-1"]);
    expect(storedIds()).not.toContain("alert-dismiss-1");

    syncCompanionAlerts([alert], { source: "poll" });
    expect(storedIds()).not.toContain("alert-dismiss-1");
  });

  it("does not record non-alert ids as dismissed", () => {
    dismissAlerts(["notif-123"]);
    expect(mockLocalStorage.getItem("tetra_dismissed_alerts_v1")).toBeNull();
  });

  it("clears the dismissed set when the day key changes", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 9, 12, 10, 0, 0));
      const alert = makeAlert("alert-day-1", "gap");
      dismissAlerts([alert.id]);
      syncCompanionAlerts([alert]);
      expect(storedIds()).not.toContain("alert-day-1");

      vi.setSystemTime(new Date(2026, 9, 13, 10, 0, 0));
      syncCompanionAlerts([alert]);
      expect(storedIds()).toContain("alert-day-1");
      dismissAlerts([alert.id]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("on poll, only agent_approval alerts trigger a browser alert", () => {
    const mockConstructor = enableBrowserAlerts();

    syncCompanionAlerts([makeAlert("alert-poll-gap", "gap")], { source: "poll" });
    expect(mockConstructor).not.toHaveBeenCalled();

    syncCompanionAlerts([makeAlert("alert-poll-approval", "agent_approval")], {
      source: "poll",
    });
    expect(mockConstructor).toHaveBeenCalledTimes(1);
    expect(mockConstructor).toHaveBeenCalledWith(
      "TETRA · Title alert-poll-approval",
      expect.anything(),
    );
    dismissAlerts(["alert-poll-gap", "alert-poll-approval"]);
  });

  it("on manual sync, both gap and agent_approval alerts trigger browser alerts", () => {
    const mockConstructor = enableBrowserAlerts();

    syncCompanionAlerts([makeAlert("alert-man-gap", "gap")], { source: "manual" });
    syncCompanionAlerts([makeAlert("alert-man-approval", "agent_approval")], {
      source: "manual",
    });
    expect(mockConstructor).toHaveBeenCalledTimes(2);
    dismissAlerts(["alert-man-gap", "alert-man-approval"]);
  });
});
