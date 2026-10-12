"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Bell,
  BellOff,
  BellRing,
  Calendar,
  CalendarX2,
  CheckCheck,
  Clock,
  ExternalLink,
  Info,
  Layers,
  ShieldAlert,
  Sparkles,
  Target,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useNotifications } from "@/features/notifications/store";
import { formatRelativeTime } from "@/features/notifications/domain";
import type { TetraNotification } from "@/features/notifications/types";
import { todayKey } from "@/lib/time";
import { startNotificationPolling } from "@/features/notifications/polling";

function getNotificationIcon(notification: TetraNotification) {
  switch (notification.type) {
    case "attendance":
      return <Clock className="size-4 text-emerald-600 dark:text-emerald-400" />;
    case "gap":
      return <Clock className="size-4 text-amber-600 dark:text-amber-400" />;
    case "meeting":
      return <Calendar className="size-4 text-indigo-600 dark:text-indigo-400" />;
    case "missing_day":
      return <CalendarX2 className="size-4 text-rose-600 dark:text-rose-400" />;
    case "weekly_target":
      return <Target className="size-4 text-violet-600 dark:text-violet-400" />;
    case "review":
      return <Sparkles className="size-4 text-primary" />;
    case "sync":
      return <Layers className="size-4 text-sky-600 dark:text-sky-400" />;
    case "timer":
      return <TriangleAlert className="size-4 text-amber-600 dark:text-amber-400" />;
    case "agent_approval":
      return <ShieldAlert className="size-4 text-amber-600 dark:text-amber-400" />;
    default:
      return <Info className="size-4 text-muted-foreground" />;
  }
}

interface NotificationMenuProps {
  timezone?: string;
}

export function NotificationMenu({ timezone = "Asia/Jakarta" }: NotificationMenuProps) {
  const {
    notifications,
    unreadCount,
    markAsRead,
    markAllAsRead,
    clearAll,
    removeNotification,
    refreshAlerts,
    browserAlertsEnabled,
    toggleBrowserAlerts,
    isBannerMutedToday,
    muteBannerToday,
    unmuteBannerToday,
  } = useNotifications();

  const currentTodayKey = todayKey(timezone);
  const isMutedToday = isBannerMutedToday(currentTodayKey);

  const [tab, setTab] = useState<"all" | "unread">("all");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    void refreshAlerts();
    return startNotificationPolling(() => refreshAlerts({ source: "poll" }), {
      isVisible: () => document.visibilityState === "visible",
      subscribeVisibility: (cb) => {
        const handler = () => {
          if (document.visibilityState === "visible") cb();
        };
        document.addEventListener("visibilitychange", handler);
        return () => document.removeEventListener("visibilitychange", handler);
      },
    });
  }, [refreshAlerts]);

  useEffect(() => {
    if (open) {
      void refreshAlerts();
    }
  }, [open, refreshAlerts]);

  const displayedNotifications = useMemo(() => {
    if (tab === "unread") {
      return notifications.filter((n) => !n.read);
    }
    return notifications;
  }, [notifications, tab]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              data-testid="notifications-trigger"
              className="relative size-9 rounded-full text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer"
              aria-label={`Notifications (${unreadCount} unread)`}
            >
              <Bell className="size-4.5 transition-transform group-hover:scale-105" />
              {unreadCount > 0 && (
                <span
                  data-testid="notifications-badge"
                  className="absolute -top-0.5 -right-0.5 flex size-4.5 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground shadow-xs animate-in zoom-in-50"
                >
                  {unreadCount > 9 ? "9+" : unreadCount}
                </span>
              )}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Notifications</TooltipContent>
      </Tooltip>

      <PopoverContent
        align="end"
        sideOffset={8}
        className="flex flex-col max-h-[520px] overflow-hidden shadow-xl"
        data-testid="notifications-panel"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/80 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="font-heading text-sm font-semibold text-foreground">
              Notifications
            </span>
            {unreadCount > 0 && (
              <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-semibold text-primary">
                {unreadCount} unread
              </span>
            )}
          </div>

          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(
                    "size-7 rounded-md cursor-pointer",
                    browserAlertsEnabled
                      ? "text-primary hover:text-primary hover:bg-primary/10"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  onClick={() => void toggleBrowserAlerts()}
                  aria-label="Toggle desktop alerts"
                >
                  <BellRing className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {browserAlertsEnabled
                  ? "Desktop alerts active"
                  : "Enable desktop alerts"}
              </TooltipContent>
            </Tooltip>

            {unreadCount > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 rounded-md text-muted-foreground hover:text-foreground cursor-pointer"
                    onClick={markAllAsRead}
                    aria-label="Mark all as read"
                  >
                    <CheckCheck className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Mark all as read</TooltipContent>
              </Tooltip>
            )}

            {notifications.length > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 rounded-md text-muted-foreground hover:text-destructive cursor-pointer"
                    onClick={clearAll}
                    aria-label="Clear all notifications"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Clear all</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>

        {/* Filter tabs */}
        <div className="flex border-b border-border/60 bg-muted/20 px-3 py-1.5 text-xs font-medium">
          <button
            type="button"
            onClick={() => setTab("all")}
            className={cn(
              "flex-1 rounded-md py-1 text-center transition-all cursor-pointer select-none",
              tab === "all"
                ? "bg-background text-foreground font-semibold shadow-2xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            All ({notifications.length})
          </button>
          <button
            type="button"
            onClick={() => setTab("unread")}
            className={cn(
              "flex-1 rounded-md py-1 text-center transition-all cursor-pointer select-none",
              tab === "unread"
                ? "bg-background text-foreground font-semibold shadow-2xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Unread ({unreadCount})
          </button>
        </div>

        {/* Content list */}
        <div className="flex-1 overflow-y-auto divide-y divide-border/40 min-h-[160px] max-h-[340px]">
          {displayedNotifications.length === 0 ? (
            <div className="flex flex-col items-center justify-center p-8 text-center gap-2">
              <div className="rounded-full bg-muted p-3 text-muted-foreground">
                <BellOff className="size-5" />
              </div>
              <p className="text-sm font-medium text-foreground">
                {tab === "unread" ? "No unread alerts" : "No notifications yet"}
              </p>
              <p className="text-xs text-muted-foreground max-w-[200px]">
                {tab === "unread"
                  ? "You are completely caught up!"
                  : "Status updates, shift reminders, and sync notices will appear here."}
              </p>
            </div>
          ) : (
            displayedNotifications.map((n) => (
              <div
                key={n.id}
                onClick={() => !n.read && markAsRead(n.id)}
                className={cn(
                  "group relative flex items-start gap-3 p-3.5 transition-colors cursor-pointer",
                  n.read
                    ? "bg-transparent hover:bg-muted/30 opacity-75 hover:opacity-100"
                    : "bg-primary/[0.04] hover:bg-primary/[0.08]",
                )}
              >
                {!n.read && (
                  <span
                    aria-hidden
                    className="absolute top-4 left-1.5 size-1.5 rounded-full bg-primary"
                  />
                )}

                <div className="mt-0.5 shrink-0 rounded-lg border border-border/60 bg-background p-1.5 shadow-2xs">
                  {getNotificationIcon(n)}
                </div>

                <div className="flex-1 min-w-0 pr-6">
                  <div className="flex items-center justify-between gap-1">
                    <p
                      className={cn(
                        "text-xs font-semibold leading-snug break-words [overflow-wrap:anywhere]",
                        n.read ? "text-foreground" : "text-foreground font-bold",
                      )}
                    >
                      {n.title}
                    </p>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground leading-relaxed break-words [overflow-wrap:anywhere]">
                    {n.message}
                  </p>

                  <div className="mt-2 flex items-center justify-between gap-2">
                    <span className="text-[10px] text-muted-foreground tabular-nums">
                      {formatRelativeTime(n.timestamp)}
                    </span>

                    {n.href && (
                      <Link
                        href={n.href}
                        onClick={() => {
                          markAsRead(n.id);
                          setOpen(false);
                        }}
                        className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
                      >
                        <span>{n.actionLabel ?? "View"}</span>
                        <ExternalLink className="size-2.5" />
                      </Link>
                    )}
                  </div>
                </div>

                <Button
                  variant="ghost"
                  size="icon"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeNotification(n.id);
                  }}
                  className="absolute top-2.5 right-2 size-6 rounded-md opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground cursor-pointer transition-opacity"
                  aria-label="Dismiss notification"
                >
                  <X className="size-3" />
                </Button>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-border/60 bg-muted/15 px-3 py-2 flex items-center justify-between text-[11px] text-muted-foreground">
          {isMutedToday ? (
            <>
              <span className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400 font-medium">
                <BellOff className="size-3 shrink-0" />
                <span>Banner snoozed today</span>
              </span>
              <button
                type="button"
                onClick={() => unmuteBannerToday()}
                className="font-medium text-primary hover:underline cursor-pointer"
                data-testid="unmute-banner-button"
              >
                Un-snooze
              </button>
            </>
          ) : (
            <>
              <span>Startup banner active</span>
              <button
                type="button"
                onClick={() => muteBannerToday(currentTodayKey)}
                className="hover:text-foreground hover:underline cursor-pointer"
                data-testid="mute-banner-button"
              >
                Snooze today
              </button>
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
