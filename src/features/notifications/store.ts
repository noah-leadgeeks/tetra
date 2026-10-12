"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { isBannerSuppressedForDate, mergeCompanionAlerts } from "./domain";
import type { TetraNotification } from "./types";

const STORAGE_KEY = "tetra_notifications_v1";
const BROWSER_NOTIF_KEY = "tetra_browser_notifications_v1";
const DISMISSED_ALERTS_KEY = "tetra_dismissed_alerts_v1";
const ALERT_ID_PREFIX = "alert-";

export type AlertSyncSource = "poll" | "manual";

const INITIAL_NOTIFICATIONS: TetraNotification[] = [];

function cleanLegacySpam(list: TetraNotification[]): TetraNotification[] {
  return list.filter(
    (n) =>
      n.title !== "Break Started" &&
      n.title !== "Break Ended" &&
      n.title !== "Workday Started" &&
      n.title !== "Workday Ended" &&
      n.id !== "welcome-system",
  );
}

export type NotificationPermissionState = NotificationPermission | "unsupported";

function tryFallbackNotification(
  title: string,
  options: NotificationOptions,
  href?: string,
): void {
  try {
    const notif = new Notification(title, options);
    if (href) {
      notif.onclick = () => {
        window.focus();
        window.location.href = href;
        notif.close();
      };
    }
  } catch {
    // Ignored if notification constructor is restricted
  }
}

export function sendBrowserAlert(title: string, body: string, href?: string): void {
  if (typeof window === "undefined" || typeof Notification === "undefined") {
    return;
  }
  if (Notification.permission === "granted") {
    const fullTitle = `TETRA · ${title}`;
    const options: NotificationOptions = {
      body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: href || "/" },
      tag: `tetra-alert-${Date.now()}`,
    };

    // If Service Worker is supported and registered, use showNotification for PWA compliance
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.ready
        .then((reg) => {
          return reg.showNotification(fullTitle, options);
        })
        .catch(() => {
          tryFallbackNotification(fullTitle, options, href);
        });
      return;
    }

    tryFallbackNotification(fullTitle, options, href);
  }
}

// Module-level in-memory cache and subscribers
let memoryNotifications: TetraNotification[] | null = null;
const notifListeners = new Set<() => void>();

function notifyNotifSubscribers() {
  for (const listener of notifListeners) {
    listener();
  }
}

function getNotificationsSnapshot(): TetraNotification[] {
  if (typeof window === "undefined") return INITIAL_NOTIFICATIONS;
  if (memoryNotifications !== null) return memoryNotifications;

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        memoryNotifications = cleanLegacySpam(parsed);
        return memoryNotifications;
      }
    }
    memoryNotifications = INITIAL_NOTIFICATIONS;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(INITIAL_NOTIFICATIONS));
  } catch {
    memoryNotifications = INITIAL_NOTIFICATIONS;
  }
  return memoryNotifications;
}

function getServerNotificationsSnapshot(): TetraNotification[] {
  return INITIAL_NOTIFICATIONS;
}

function setStoredNotifications(next: TetraNotification[]) {
  memoryNotifications = next;
  try {
    if (typeof window !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    }
  } catch {
    // Ignore storage quota error
  }
  notifyNotifSubscribers();
}

function subscribeToNotifications(callback: () => void) {
  notifListeners.add(callback);

  const handleCustomNotify = (e: Event) => {
    const detail = (e as CustomEvent<Omit<TetraNotification, "id" | "timestamp" | "read">>).detail;
    if (!detail) return;

    const newNotification: TetraNotification = {
      id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      read: false,
      ...detail,
    };

    const current = getNotificationsSnapshot();
    const updated = [newNotification, ...current.filter((n) => n.id !== newNotification.id)].slice(0, 40);
    setStoredNotifications(updated);

    try {
      if (
        typeof Notification !== "undefined" &&
        Notification.permission === "granted" &&
        localStorage.getItem(BROWSER_NOTIF_KEY) === "true"
      ) {
        sendBrowserAlert(newNotification.title, newNotification.message);
      }
    } catch {
      // Ignore
    }
  };

  const handleStorageChange = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY && e.newValue) {
      try {
        const parsed = JSON.parse(e.newValue);
        if (Array.isArray(parsed)) {
          memoryNotifications = parsed;
          notifyNotifSubscribers();
        }
      } catch {
        // Ignore
      }
    }
  };

  window.addEventListener("tetra:notify", handleCustomNotify);
  window.addEventListener("storage", handleStorageChange);

  return () => {
    notifListeners.delete(callback);
    window.removeEventListener("tetra:notify", handleCustomNotify);
    window.removeEventListener("storage", handleStorageChange);
  };
}

// Browser alerts preference state
let memoryBrowserAlerts: boolean | null = null;
const alertPrefListeners = new Set<() => void>();

function notifyAlertPrefSubscribers() {
  for (const listener of alertPrefListeners) {
    listener();
  }
}

function getBrowserAlertsSnapshot(): boolean {
  if (typeof window === "undefined" || typeof Notification === "undefined") return false;
  if (memoryBrowserAlerts !== null) return memoryBrowserAlerts;

  try {
    const pref = localStorage.getItem(BROWSER_NOTIF_KEY);
    memoryBrowserAlerts = pref === "true" && Notification.permission === "granted";
  } catch {
    memoryBrowserAlerts = false;
  }
  return memoryBrowserAlerts;
}

function getServerBrowserAlertsSnapshot(): boolean {
  return false;
}

function subscribeToBrowserAlerts(callback: () => void) {
  alertPrefListeners.add(callback);
  const handleStorageChange = (e: StorageEvent) => {
    if (e.key === BROWSER_NOTIF_KEY) {
      memoryBrowserAlerts = e.newValue === "true";
      notifyAlertPrefSubscribers();
    }
  };
  window.addEventListener("storage", handleStorageChange);
  return () => {
    alertPrefListeners.delete(callback);
    window.removeEventListener("storage", handleStorageChange);
  };
}

// Banner overlay suppression preference state (per calendar date)
const BANNER_SUPPRESSED_KEY = "tetra_banner_suppressed_date_v1";
let memoryBannerSuppressedDate: string | null = null;
const bannerPrefListeners = new Set<() => void>();

function notifyBannerPrefSubscribers() {
  for (const listener of bannerPrefListeners) {
    listener();
  }
}

function getBannerSuppressedDateSnapshot(): string | null {
  if (typeof window === "undefined") return null;
  if (memoryBannerSuppressedDate !== null) return memoryBannerSuppressedDate;
  try {
    memoryBannerSuppressedDate = localStorage.getItem(BANNER_SUPPRESSED_KEY);
  } catch {
    memoryBannerSuppressedDate = null;
  }
  return memoryBannerSuppressedDate;
}

function getServerBannerSuppressedSnapshot(): string | null {
  return null;
}

function subscribeToBannerSuppressed(callback: () => void) {
  bannerPrefListeners.add(callback);
  const handleStorageChange = (e: StorageEvent) => {
    if (e.key === BANNER_SUPPRESSED_KEY) {
      memoryBannerSuppressedDate = e.newValue;
      notifyBannerPrefSubscribers();
    }
  };
  window.addEventListener("storage", handleStorageChange);
  return () => {
    bannerPrefListeners.delete(callback);
    window.removeEventListener("storage", handleStorageChange);
  };
}

export function suppressBannerToday(currentTodayKey: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(BANNER_SUPPRESSED_KEY, currentTodayKey);
    memoryBannerSuppressedDate = currentTodayKey;
    notifyBannerPrefSubscribers();
  } catch {
    // Ignore
  }
}

export function unsuppressBannerToday(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(BANNER_SUPPRESSED_KEY);
    memoryBannerSuppressedDate = null;
    notifyBannerPrefSubscribers();
  } catch {
    // Ignore
  }
}

// Permission state
let memoryPermission: NotificationPermissionState | null = null;
const permissionListeners = new Set<() => void>();

function notifyPermissionSubscribers() {
  for (const listener of permissionListeners) {
    listener();
  }
}

function getPermissionSnapshot(): NotificationPermissionState {
  if (typeof window === "undefined" || typeof Notification === "undefined") {
    return "unsupported";
  }
  if (memoryPermission !== null) {
    return memoryPermission;
  }
  return Notification.permission;
}

function getServerPermissionSnapshot(): NotificationPermissionState {
  return "unsupported";
}

function subscribeToPermission(callback: () => void) {
  permissionListeners.add(callback);
  return () => {
    permissionListeners.delete(callback);
  };
}

// Hydration helper
function subscribeHydration() {
  return () => {};
}
function getHydrationSnapshot() {
  return true;
}
function getServerHydrationSnapshot() {
  return false;
}

export function emitNotification(
  notification: Omit<TetraNotification, "id" | "timestamp" | "read">,
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("tetra:notify", {
      detail: notification,
    }),
  );
}

function localDayKey(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function readDismissedAlertIds(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_ALERTS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as { dayKey?: unknown; ids?: unknown };
    if (parsed.dayKey !== localDayKey() || !Array.isArray(parsed.ids)) {
      return new Set();
    }
    return new Set(parsed.ids.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set();
  }
}

function recordDismissedAlertIds(ids: string[]): void {
  const alertIds = ids.filter((id) => id.startsWith(ALERT_ID_PREFIX));
  if (alertIds.length === 0) return;
  try {
    const merged = new Set([...readDismissedAlertIds(), ...alertIds]);
    localStorage.setItem(
      DISMISSED_ALERTS_KEY,
      JSON.stringify({ dayKey: localDayKey(), ids: [...merged] }),
    );
  } catch {
    // Ignore storage errors
  }
}

/**
 * Removes notifications by id and remembers dismissed server alerts
 * (`alert-*`) for the rest of the local day so polling does not resurrect them.
 */
export function dismissAlerts(ids: string[]): void {
  if (typeof window === "undefined") return;
  const idSet = new Set(ids);
  recordDismissedAlertIds(ids);
  const current = getNotificationsSnapshot();
  setStoredNotifications(current.filter((n) => !idSet.has(n.id)));
}

export function syncCompanionAlerts(
  incoming: TetraNotification[],
  { source = "manual" }: { source?: AlertSyncSource } = {},
): void {
  const dismissed = readDismissedAlertIds();
  const serverAlerts =
    dismissed.size > 0 ? incoming.filter((a) => !dismissed.has(a.id)) : incoming;
  const current = cleanLegacySpam(getNotificationsSnapshot());
  const existingIds = new Set(current.map((n) => n.id));
  const updated = mergeCompanionAlerts(current, serverAlerts);
  setStoredNotifications(updated);

  // If user enabled browser alerts, notify about newly surfaced warnings or reminders
  if (
    typeof Notification !== "undefined" &&
    Notification.permission === "granted" &&
    typeof window !== "undefined" &&
    localStorage.getItem(BROWSER_NOTIF_KEY) === "true"
  ) {
    const newAlerts = serverAlerts.filter(
      (a) =>
        !existingIds.has(a.id) &&
        !a.read &&
        (a.severity === "warning" || a.severity === "reminder") &&
        (source !== "poll" || a.type === "agent_approval"),
    );
    if (newAlerts.length > 0) {
      const first = newAlerts[0];
      sendBrowserAlert(first.title, first.message, first.href);
    }
  }
}

export function useNotifications() {
  const notifications = useSyncExternalStore(
    subscribeToNotifications,
    getNotificationsSnapshot,
    getServerNotificationsSnapshot,
  );

  const browserAlertsEnabled = useSyncExternalStore(
    subscribeToBrowserAlerts,
    getBrowserAlertsSnapshot,
    getServerBrowserAlertsSnapshot,
  );

  const permission = useSyncExternalStore(
    subscribeToPermission,
    getPermissionSnapshot,
    getServerPermissionSnapshot,
  );

  const bannerSuppressedDate = useSyncExternalStore(
    subscribeToBannerSuppressed,
    getBannerSuppressedDateSnapshot,
    getServerBannerSuppressedSnapshot,
  );

  const isLoaded = useSyncExternalStore(
    subscribeHydration,
    getHydrationSnapshot,
    getServerHydrationSnapshot,
  );

  const unreadCount = useMemo(() => {
    return notifications.filter((n) => !n.read).length;
  }, [notifications]);

  const markAsRead = useCallback((id: string) => {
    const current = getNotificationsSnapshot();
    setStoredNotifications(
      current.map((n) => (n.id === id ? { ...n, read: true } : n)),
    );
  }, []);

  const markAllAsRead = useCallback(() => {
    const current = getNotificationsSnapshot();
    setStoredNotifications(current.map((n) => ({ ...n, read: true })));
  }, []);

  const removeNotification = useCallback((id: string) => {
    dismissAlerts([id]);
  }, []);

  const clearAll = useCallback(() => {
    dismissAlerts(getNotificationsSnapshot().map((n) => n.id));
    setStoredNotifications([]);
  }, []);

  const refreshAlerts = useCallback(async (opts?: { source?: AlertSyncSource }) => {
    try {
      const res = await fetch("/api/notifications");
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.notifications)) {
          syncCompanionAlerts(data.notifications, { source: opts?.source ?? "manual" });
        }
      }
    } catch {
      // Ignore network errors
    }
  }, []);

  const requestPermission = useCallback(async (): Promise<NotificationPermissionState> => {
    if (typeof window === "undefined" || typeof Notification === "undefined") {
      return "unsupported";
    }

    try {
      const result = await Notification.requestPermission();
      memoryPermission = result;
      notifyPermissionSubscribers();

      if (result === "granted") {
        memoryBrowserAlerts = true;
        localStorage.setItem(BROWSER_NOTIF_KEY, "true");
        notifyAlertPrefSubscribers();
        sendBrowserAlert(
          "Notifications Active",
          "You will receive timely alerts for shifts, breaks, and timers.",
          "/settings",
        );
      } else {
        memoryBrowserAlerts = false;
        localStorage.setItem(BROWSER_NOTIF_KEY, "false");
        notifyAlertPrefSubscribers();
      }
      return result;
    } catch {
      return "unsupported";
    }
  }, []);

  const sendTestNotification = useCallback(() => {
    sendBrowserAlert(
      "Test Notification",
      "Notifications and PWA alerts are configured and working properly!",
      "/settings",
    );
  }, []);

  const toggleBrowserAlerts = useCallback(async (): Promise<boolean> => {
    if (typeof window === "undefined" || typeof Notification === "undefined") {
      return false;
    }

    if (Notification.permission === "granted") {
      const nextState = !getBrowserAlertsSnapshot();
      memoryBrowserAlerts = nextState;
      localStorage.setItem(BROWSER_NOTIF_KEY, String(nextState));
      notifyAlertPrefSubscribers();
      if (nextState) {
        sendBrowserAlert(
          "Notifications Enabled",
          "Desktop and companion alerts are now active for TETRA.",
          "/settings",
        );
      }
      return nextState;
    }

    if (Notification.permission === "denied") {
      return false;
    }

    const permissionResult = await Notification.requestPermission();
    memoryPermission = permissionResult;
    notifyPermissionSubscribers();
    const granted = permissionResult === "granted";
    memoryBrowserAlerts = granted;
    localStorage.setItem(BROWSER_NOTIF_KEY, String(granted));
    notifyAlertPrefSubscribers();
    if (granted) {
      sendBrowserAlert(
        "Notifications Enabled",
        "Desktop and companion alerts are now active for TETRA.",
        "/settings",
      );
    }
    return granted;
  }, []);

  const isBannerMutedToday = useCallback(
    (today: string) => isBannerSuppressedForDate(bannerSuppressedDate, today),
    [bannerSuppressedDate],
  );

  const muteBannerToday = useCallback((today: string) => {
    suppressBannerToday(today);
  }, []);

  const unmuteBannerToday = useCallback(() => {
    unsuppressBannerToday();
  }, []);

  return {
    notifications,
    unreadCount,
    isLoaded,
    markAsRead,
    markAllAsRead,
    removeNotification,
    clearAll,
    refreshAlerts,
    browserAlertsEnabled,
    permission,
    requestPermission,
    sendTestNotification,
    toggleBrowserAlerts,
    bannerSuppressedDate,
    isBannerMutedToday,
    muteBannerToday,
    unmuteBannerToday,
  };
}
