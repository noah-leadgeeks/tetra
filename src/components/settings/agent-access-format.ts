/** Pure render helpers for the agent access settings page (unit-tested in node). */

export interface ImpactDescription {
  lines: string[];
  warnings: string[];
}

export const GOOGLE_READ_ONLY_WARNING =
  "Google access is read-only: this event will be removed only in Tetra and will come back on the next calendar sync — reconnect Google first";

export function formatMinutes(total: number): string {
  const safe = Math.max(0, Math.round(total));
  const h = Math.floor(safe / 60);
  const m = safe % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function describeImpact(
  targetType: string,
  impact: Record<string, unknown> | undefined | null,
): ImpactDescription {
  const i = impact ?? {};
  const lines: string[] = [];
  const warnings: string[] = [];
  switch (targetType) {
    case "task": {
      const n = num(i.entryCount);
      lines.push(
        `will also delete ${n} ${n === 1 ? "entry" : "entries"} (${formatMinutes(num(i.totalMinutes))})`,
      );
      if (i.activeEntry === true) lines.push("including the running timer");
      break;
    }
    case "time_entry":
      lines.push(`removes ${formatMinutes(num(i.minutes))} of tracked time`);
      break;
    case "break":
      lines.push(`removes a ${formatMinutes(num(i.minutes))} break`);
      break;
    case "calendar_event": {
      const linked = i.googleLinked === true;
      lines.push(linked ? "linked to Google" : "not linked");
      if (i.notifiesGuests === true) {
        const g = num(i.guestCount);
        lines.push(`${g} ${g === 1 ? "guest" : "guests"} will be notified`);
      }
      if (linked && i.canWriteGoogle !== true) warnings.push(GOOGLE_READ_ONLY_WARNING);
      break;
    }
  }
  return { lines, warnings };
}

export interface ActionResultLike {
  status: string;
  result: Record<string, unknown> | null;
}

/** Short text for the activity list. */
export function summarizeResult(action: ActionResultLike): string {
  const r = action.result ?? {};
  if (typeof r.error === "string") return r.error;
  if (action.status === "executed") {
    const days = needsSyncDays(r);
    return days.length > 0 ? "Deleted. Not synced — open Timeline to sync" : "Deleted";
  }
  if (typeof r.code === "string") return r.code.replace(/_/g, " ");
  return "";
}

export function needsSyncDays(result: Record<string, unknown> | null | undefined): string[] {
  const v = result?.needsSync;
  return Array.isArray(v) ? v.filter((d): d is string => typeof d === "string") : [];
}

export function needsSyncMessage(days: string[]): string | null {
  return days.length > 0
    ? `Not synced — open Timeline to sync (${days.join(", ")})`
    : null;
}
