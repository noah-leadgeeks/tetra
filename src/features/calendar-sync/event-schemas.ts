import { z } from "zod";

import { isoInstant } from "@/lib/zod-time";

export const guestSchema = z.union([
  z.string().email(),
  z.object({
    email: z.string().email(),
    displayName: z.string().optional(),
  }),
]);

/** POST /api/calendar/events body. */
export const createEventSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(500),
  description: z.string().nullable().optional(),
  categoryId: z.string().uuid().nullable().optional(),
  startAt: z.string().min(1, "Start time is required"),
  endAt: z.string().min(1, "End time is required"),
  allDay: z.boolean().optional(),
  guests: z.array(guestSchema).optional(),
  createMeet: z.boolean().optional(),
  sendUpdates: z.enum(["all", "none"]).optional(),
});

/** PATCH /api/calendar/events/:id body. */
export const updateEventSchema = z.object({
  title: z.string().trim().min(1, "Title cannot be empty").max(500).optional(),
  description: z.string().nullable().optional(),
  categoryId: z.string().uuid().nullable().optional(),
  startAt: z.string().optional(),
  endAt: z.string().optional(),
  allDay: z.boolean().optional(),
  guests: z.array(guestSchema).optional(),
  createMeet: z.boolean().optional(),
  sendUpdates: z.enum(["all", "none"]).optional(),
});

/** Agent variants require timestamps with an explicit offset. */
export const agentCreateEventSchema = createEventSchema.extend({
  startAt: isoInstant,
  endAt: isoInstant,
});

export const agentUpdateEventSchema = updateEventSchema.extend({
  startAt: isoInstant.optional(),
  endAt: isoInstant.optional(),
});
