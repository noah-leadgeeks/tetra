import { z } from "zod";

import { sheetSafeText } from "@/lib/zod-text";
import { isoDate, isoInstant } from "@/lib/zod-time";

/** POST /api/tasks body. */
export const createTaskSchema = z.object({
  name: z.string().trim().min(1, "Task name is required").max(300),
  categoryId: z.string().uuid("Invalid category ID"),
  status: z
    .enum([
      "backlog",
      "todo",
      "in_progress",
      "blocked",
      "review",
      "done",
      "cancelled",
    ])
    .optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  description: z.string().nullable().optional(),
  isFavorite: z.boolean().optional(),
  dueAt: z
    .string()
    .nullable()
    .optional()
    .transform((val) => (val ? new Date(val) : null)),
});

/**
 * PATCH /api/tasks/:id body. Date transforms preserve `undefined` so an absent
 * field is not treated as an explicit clear by `updateTask`.
 */
export const updateTaskSchema = z.object({
  name: z.string().trim().min(1, "Task name cannot be empty").max(300).optional(),
  categoryId: z.string().uuid("Invalid category ID").optional(),
  status: z
    .enum([
      "backlog",
      "todo",
      "in_progress",
      "blocked",
      "review",
      "done",
      "cancelled",
    ])
    .optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  description: z.string().nullable().optional(),
  isFavorite: z.boolean().optional(),
  dueAt: z
    .string()
    .nullable()
    .optional()
    .transform((val) => (val === undefined ? undefined : val ? new Date(val) : null)),
  startedAt: z
    .string()
    .nullable()
    .optional()
    .transform((val) => (val === undefined ? undefined : val ? new Date(val) : null)),
  completedAt: z
    .string()
    .nullable()
    .optional()
    .transform((val) => (val === undefined ? undefined : val ? new Date(val) : null)),
});

/**
 * Agent create: `dueAt` is replaced by a date-only `dueDate`; a stray `dueAt` is
 * rejected. The category may be given by `categoryId` or `categoryKey`.
 */
export const agentCreateTaskSchema = createTaskSchema
  .omit({ dueAt: true })
  .extend({
    name: sheetSafeText(300, "Task name is required"),
    categoryId: z.uuid("Invalid category ID").optional(),
    categoryKey: z.string().trim().min(1).optional(),
    dueDate: isoDate.nullable().optional(),
  })
  .strict();

/**
 * Agent update: `dueAt` is replaced by a date-only `dueDate`; a stray `dueAt` is
 * rejected. The category may be given by `categoryId` or `categoryKey`.
 */
export const agentUpdateTaskSchema = updateTaskSchema
  .omit({ dueAt: true })
  .extend({
    name: sheetSafeText(300, "Task name cannot be empty").optional(),
    categoryKey: z.string().trim().min(1).optional(),
    dueDate: isoDate.nullable().optional(),
    // Offset-less timestamps would be read in the server's zone; require an instant.
    startedAt: isoInstant
      .nullable()
      .optional()
      .transform((val) => (val === undefined ? undefined : val ? new Date(val) : null)),
    completedAt: isoInstant
      .nullable()
      .optional()
      .transform((val) => (val === undefined ? undefined : val ? new Date(val) : null)),
  })
  .strict();
