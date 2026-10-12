import { z } from "zod";

/** ISO-8601 instant that must carry an offset (`Z` or `±hh:mm`); naive strings are rejected. */
export const isoInstant = z.iso.datetime({ offset: true });

/** Calendar date, `YYYY-MM-DD`. */
export const isoDate = z.iso.date();

/** Storage convention for task due dates (see src/components/tasks/task-dates.ts). */
export function dueAtFromDate(date: string): string {
  return `${date}T23:59:59Z`;
}
