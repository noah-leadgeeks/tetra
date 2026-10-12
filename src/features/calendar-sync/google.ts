/**
 * Google Calendar client construction & API calls — mirrors sheets-sync/google.ts.
 * googleapis is loaded lazily so routes compile fast and unconfigured environments
 * never pay the import cost.
 */
import { eq } from "drizzle-orm";
import type { calendar_v3 } from "googleapis";

import { db } from "@/server/db";
import { users } from "@/server/db/schema";
import { env } from "@/server/env";
import type { CalendarItemDTO } from "./types";

export interface GetCalendarClientOptions {
  userId?: string;
  accessToken?: string;
}

/**
 * Returns an authenticated Google Calendar client.
 */
export async function getCalendarClient(
  options?: GetCalendarClientOptions,
): Promise<calendar_v3.Calendar | null> {
  const { google } = await import("googleapis");

  // 1. User OAuth credentials from DB (preferred because it has refresh token & auto-refresh persistence)
  if (options?.userId) {
    const userRows = await db
      .select()
      .from(users)
      .where(eq(users.id, options.userId))
      .limit(1);

    const user = userRows[0];
    if (
      user &&
      (user.googleAccessToken || user.googleRefreshToken || options.accessToken)
    ) {
      const clientId =
        env.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || undefined;
      const clientSecret =
        env.GOOGLE_CLIENT_SECRET ||
        process.env.GOOGLE_CLIENT_SECRET ||
        undefined;

      const oauth2 = new google.auth.OAuth2(clientId, clientSecret);

      oauth2.setCredentials({
        access_token: user.googleAccessToken || options.accessToken,
        refresh_token: user.googleRefreshToken ?? undefined,
      });

      // Refresh if expired or expiring within 60 seconds
      const isExpired =
        !user.googleAccessToken ||
        (user.googleTokenExpiresAt &&
          user.googleTokenExpiresAt.getTime() < Date.now() + 60_000);

      if (
        isExpired &&
        user.googleRefreshToken &&
        (clientId || process.env.NODE_ENV === "test")
      ) {
        try {
          const { credentials } = await oauth2.refreshAccessToken();
          if (credentials.access_token) {
            oauth2.setCredentials(credentials);
            await db
              .update(users)
              .set({
                googleAccessToken: credentials.access_token,
                ...(credentials.refresh_token
                  ? { googleRefreshToken: credentials.refresh_token }
                  : {}),
                googleTokenExpiresAt: credentials.expiry_date
                  ? new Date(credentials.expiry_date)
                  : null,
              })
              .where(eq(users.id, user.id));
          }
        } catch (refreshErr) {
          console.error("Failed to refresh Google OAuth token for calendar:", refreshErr);
          if (options.accessToken) {
            oauth2.setCredentials({ access_token: options.accessToken });
          }
        }
      }

      return google.calendar({ version: "v3", auth: oauth2 });
    }
  }

  // 2. Explicit access token fallback
  if (options?.accessToken) {
    const oauth2 = new google.auth.OAuth2(
      env.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || undefined,
      env.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || undefined,
    );
    oauth2.setCredentials({ access_token: options.accessToken });
    return google.calendar({ version: "v3", auth: oauth2 });
  }

  return null;
}

/**
 * Lists the user's available calendars (Primary, Work, etc.).
 */
export async function listUserCalendars(
  options: GetCalendarClientOptions,
): Promise<CalendarItemDTO[]> {
  const client = await getCalendarClient(options);
  if (!client) {
    // Return default primary calendar placeholder if not connected
    return [{ id: "primary", summary: "Primary Calendar", primary: true }];
  }

  try {
    const res = await client.calendarList.list();
    const items = res.data.items ?? [];
    return items.map((item) => ({
      id: item.id ?? "primary",
      summary: item.summary ?? "Calendar",
      primary: item.primary ?? false,
      description: item.description ?? undefined,
    }));
  } catch (err) {
    console.error("Failed to list Google Calendars:", err);
    return [{ id: "primary", summary: "Primary Calendar", primary: true }];
  }
}

export interface RawCalendarEvent {
  id: string;
  summary: string;
  description?: string | null;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  status?: string;
  meetUrl?: string | null;
  guests?: Array<{
    email: string;
    displayName?: string | null;
    responseStatus?: "needsAction" | "declined" | "tentative" | "accepted" | null;
  }>;
  htmlLink?: string | null;
  transparency?: string | null;
  location?: string | null;
}

/**
 * Extracts a Google Meet URL from event location or description text as a fallback.
 */
function extractGoogleMeetUrl(
  description?: string | null,
  location?: string | null,
): string | null {
  const text = `${location ?? ""} ${description ?? ""}`;
  const match = text.match(/https?:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i);
  return match ? match[0] : null;
}

/**
 * Fetches events in a UTC time range from Google Calendar API.
 */
export async function fetchCalendarEvents(options: {
  userId: string;
  calendarId?: string;
  timeMin: Date;
  timeMax: Date;
  timeZone: string;
}): Promise<RawCalendarEvent[]> {
  const client = await getCalendarClient({ userId: options.userId });
  if (!client) {
    return [];
  }

  try {
    const allItems: calendar_v3.Schema$Event[] = [];
    let pageToken: string | undefined = undefined;
    const MAX_PAGES = 5; // Safety cap: up to 5 * 2500 = 12,500 events
    let pageCount = 0;

    do {
      const listParams: calendar_v3.Params$Resource$Events$List & { conferenceDataVersion?: number } = {
        calendarId: options.calendarId || "primary",
        timeMin: options.timeMin.toISOString(),
        timeMax: options.timeMax.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
        timeZone: options.timeZone,
        conferenceDataVersion: 1,
        maxResults: 2500,
        pageToken,
      };

      const res = await client.events.list(listParams as calendar_v3.Params$Resource$Events$List);
      if (res.data.items && res.data.items.length > 0) {
        allItems.push(...res.data.items);
      }
      pageToken = res.data.nextPageToken ?? undefined;
      pageCount++;
    } while (pageToken && pageCount < MAX_PAGES);

    return allItems
      .filter((item) => item.status !== "cancelled" && item.summary)
      .map((item) => {
        const meetUrl =
          item.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri ||
          item.hangoutLink ||
          extractGoogleMeetUrl(item.description, item.location) ||
          null;

        const guests = (item.attendees ?? []).map((a) => ({
          email: a.email || "",
          displayName: a.displayName || null,
          responseStatus: (a.responseStatus as "needsAction" | "declined" | "tentative" | "accepted" | null) || null,
        }));

        return {
          id: item.id ?? Math.random().toString(36).slice(2),
          summary: item.summary ?? "Untitled Event",
          description: item.description ?? null,
          start: {
            dateTime: item.start?.dateTime ?? undefined,
            date: item.start?.date ?? undefined,
          },
          end: {
            dateTime: item.end?.dateTime ?? undefined,
            date: item.end?.date ?? undefined,
          },
          status: item.status ?? "confirmed",
          meetUrl,
          guests,
          htmlLink: item.htmlLink ?? null,
          transparency: item.transparency ?? null,
          location: item.location ?? null,
        };
      });
  } catch (err) {
    console.error("Failed to fetch Google Calendar events:", err);
    return [];
  }
}

/**
 * Inserts a new event into Google Calendar, optionally creating a Google Meet conference.
 */
export async function createGoogleCalendarEvent(options: {
  userId: string;
  calendarId?: string;
  title: string;
  description?: string | null;
  startAt: Date | string;
  endAt: Date | string;
  allDay?: boolean;
  timeZone: string;
  createMeet?: boolean;
  guests?: Array<string | { email: string; displayName?: string }>;
  sendUpdates?: "all" | "none";
}): Promise<{
  googleEventId: string;
  meetUrl: string | null;
  htmlLink: string | null;
  status: string;
  guests: Array<{ email: string; displayName?: string | null; responseStatus?: "needsAction" | "declined" | "tentative" | "accepted" | null }>;
} | null> {
  const client = await getCalendarClient({ userId: options.userId });
  if (!client) {
    return null;
  }

  const attendees = options.guests?.map((g) => {
    if (typeof g === "string") return { email: g };
    return { email: g.email, displayName: g.displayName || undefined };
  });

  const startObj = options.allDay
    ? {
        date:
          typeof options.startAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(options.startAt)
            ? options.startAt
            : new Date(options.startAt).toISOString().split("T")[0],
      }
    : {
        dateTime: new Date(options.startAt).toISOString(),
        timeZone: options.timeZone,
      };

  const endObj = options.allDay
    ? {
        date:
          typeof options.endAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(options.endAt)
            ? options.endAt
            : new Date(options.endAt).toISOString().split("T")[0],
      }
    : {
        dateTime: new Date(options.endAt).toISOString(),
        timeZone: options.timeZone,
      };

  const res = await client.events.insert({
    calendarId: options.calendarId || "primary",
    conferenceDataVersion: options.createMeet ? 1 : 0,
    sendUpdates: options.sendUpdates ?? (attendees && attendees.length > 0 ? "all" : "none"),
    requestBody: {
      summary: options.title,
      description: options.description || undefined,
      start: startObj,
      end: endObj,
      attendees,
      conferenceData: options.createMeet
        ? {
            createRequest: {
              requestId: crypto.randomUUID(),
              conferenceSolutionKey: { type: "hangoutsMeet" },
            },
          }
        : undefined,
    },
  });

  const meetUrl =
    res.data.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri ||
    res.data.hangoutLink ||
    null;

  return {
    googleEventId: res.data.id || crypto.randomUUID(),
    meetUrl,
    htmlLink: res.data.htmlLink || null,
    status: res.data.status || "confirmed",
    guests: (res.data.attendees ?? []).map((a) => ({
      email: a.email || "",
      displayName: a.displayName || null,
      responseStatus: (a.responseStatus as "needsAction" | "declined" | "tentative" | "accepted" | null) || null,
    })),
  };
}

/**
 * Patches an existing Google Calendar event.
 */
export async function patchGoogleCalendarEvent(options: {
  userId: string;
  calendarId?: string;
  googleEventId: string;
  title?: string;
  description?: string | null;
  startAt?: Date | string;
  endAt?: Date | string;
  allDay?: boolean;
  timeZone: string;
  createMeet?: boolean;
  guests?: Array<string | { email: string; displayName?: string }>;
  sendUpdates?: "all" | "none";
}): Promise<{
  googleEventId: string;
  meetUrl: string | null;
  htmlLink: string | null;
  status: string;
  guests: Array<{ email: string; displayName?: string | null; responseStatus?: "needsAction" | "declined" | "tentative" | "accepted" | null }>;
} | null> {
  const client = await getCalendarClient({ userId: options.userId });
  if (!client) {
    return null;
  }

  const patchBody: Record<string, unknown> = {};

  if (options.title !== undefined) {
    patchBody.summary = options.title;
  }
  if (options.description !== undefined) {
    patchBody.description = options.description || null;
  }
  if (options.startAt !== undefined) {
    patchBody.start = options.allDay
      ? {
          date:
            typeof options.startAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(options.startAt)
              ? options.startAt
              : new Date(options.startAt).toISOString().split("T")[0],
        }
      : {
          dateTime: new Date(options.startAt).toISOString(),
          timeZone: options.timeZone,
        };
  }
  if (options.endAt !== undefined) {
    patchBody.end = options.allDay
      ? {
          date:
            typeof options.endAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(options.endAt)
              ? options.endAt
              : new Date(options.endAt).toISOString().split("T")[0],
        }
      : {
          dateTime: new Date(options.endAt).toISOString(),
          timeZone: options.timeZone,
        };
  }
  if (options.guests !== undefined) {
    patchBody.attendees = options.guests.map((g) => {
      if (typeof g === "string") return { email: g };
      return { email: g.email, displayName: g.displayName || undefined };
    });
  }
  if (options.createMeet) {
    patchBody.conferenceData = {
      createRequest: {
        requestId: crypto.randomUUID(),
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    };
  }

  const res = await client.events.patch({
    calendarId: options.calendarId || "primary",
    eventId: options.googleEventId,
    conferenceDataVersion: options.createMeet ? 1 : 0,
    sendUpdates: options.sendUpdates ?? "all",
    requestBody: patchBody,
  });

  const meetUrl =
    res.data.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri ||
    res.data.hangoutLink ||
    null;

  return {
    googleEventId: res.data.id || options.googleEventId,
    meetUrl,
    htmlLink: res.data.htmlLink || null,
    status: res.data.status || "confirmed",
    guests: (res.data.attendees ?? []).map((a) => ({
      email: a.email || "",
      displayName: a.displayName || null,
      responseStatus: (a.responseStatus as "needsAction" | "declined" | "tentative" | "accepted" | null) || null,
    })),
  };
}

/**
 * Deletes an event from Google Calendar.
 */
export async function deleteGoogleCalendarEvent(options: {
  userId: string;
  calendarId?: string;
  googleEventId: string;
  sendUpdates?: "all" | "none";
}): Promise<{ ok: boolean; error: string | null; code?: "no_client" | "gone" }> {
  const client = await getCalendarClient({ userId: options.userId });
  if (!client) {
    return { ok: false, error: "not_linked", code: "no_client" };
  }

  try {
    await client.events.delete({
      calendarId: options.calendarId || "primary",
      eventId: options.googleEventId,
      sendUpdates: options.sendUpdates ?? "all",
    });
    return { ok: true, error: null };
  } catch (err) {
    const status = (err as { code?: number; status?: number } | null)?.code ??
      (err as { status?: number } | null)?.status;
    if (status === 404 || status === 410) {
      return { ok: true, error: null, code: "gone" };
    }
    console.error("Failed to delete Google Calendar event:", err);
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Google Calendar request failed",
    };
  }
}
