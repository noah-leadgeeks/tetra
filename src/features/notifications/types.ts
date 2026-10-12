export type NotificationType =
  | "attendance"
  | "timer"
  | "review"
  | "sync"
  | "system"
  | "gap"
  | "meeting"
  | "missing_day"
  | "weekly_target"
  | "agent_approval";

export type NotificationSeverity =
  | "info"
  | "warning"
  | "success"
  | "reminder";

export interface TetraNotification {
  id: string;
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  message: string;
  timestamp: string;
  read: boolean;
  href?: string;
  actionLabel?: string;
}
