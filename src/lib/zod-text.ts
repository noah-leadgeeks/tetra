import { z } from "zod";

/** Characters a spreadsheet treats as the start of a formula (or an injection vector). */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

export const FORMULA_LEAD_MESSAGE =
  "Must not start with =, +, -, @, tab or carriage return";

/**
 * Agent-supplied free text that is later written to a spreadsheet cell: trimmed,
 * non-empty and rejected when it starts with a formula-trigger character.
 * Used by agent schemas only; UI schemas keep accepting such text.
 */
export function sheetSafeText(max?: number, emptyMessage?: string) {
  const base = z.string().trim().min(1, emptyMessage);
  const bounded = max === undefined ? base : base.max(max);
  return bounded.refine((v) => !FORMULA_LEAD.test(v), { error: FORMULA_LEAD_MESSAGE });
}
