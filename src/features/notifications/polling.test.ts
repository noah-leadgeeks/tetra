import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTIFICATION_POLL_MS, startNotificationPolling } from "./polling";

describe("startNotificationPolling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not call refresh at start and calls once after 60s", () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const stop = startNotificationPolling(refresh);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(NOTIFICATION_POLL_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
    stop();
  });

  it("skips ticks while hidden", () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const stop = startNotificationPolling(refresh, { isVisible: () => false });
    vi.advanceTimersByTime(NOTIFICATION_POLL_MS * 3);
    expect(refresh).not.toHaveBeenCalled();
    stop();
  });

  it("refreshes immediately when the visibility callback fires", () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    let fire: () => void = () => {};
    const stop = startNotificationPolling(refresh, {
      subscribeVisibility: (cb) => {
        fire = cb;
        return () => {};
      },
    });
    fire();
    expect(refresh).toHaveBeenCalledTimes(1);
    stop();
  });

  it("stops polling and unsubscribes on stop()", () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const unsubscribe = vi.fn();
    const stop = startNotificationPolling(refresh, {
      subscribeVisibility: () => unsubscribe,
    });
    stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(NOTIFICATION_POLL_MS * 3);
    expect(refresh).not.toHaveBeenCalled();
  });
});
