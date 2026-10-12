export const NOTIFICATION_POLL_MS = 60_000;

export interface NotificationPollingOptions {
  intervalMs?: number;
  isVisible?: () => boolean;
  /** Registers a callback fired when the page becomes visible; returns an unsubscribe. */
  subscribeVisibility?: (cb: () => void) => () => void;
}

export function startNotificationPolling(
  refresh: () => Promise<void>,
  {
    intervalMs = NOTIFICATION_POLL_MS,
    isVisible = () => true,
    subscribeVisibility,
  }: NotificationPollingOptions = {},
): () => void {
  const run = () => {
    void Promise.resolve(refresh()).catch(() => {});
  };
  const timer = setInterval(() => {
    if (isVisible()) run();
  }, intervalMs);
  const unsubscribe = subscribeVisibility?.(run);

  return () => {
    clearInterval(timer);
    unsubscribe?.();
  };
}
