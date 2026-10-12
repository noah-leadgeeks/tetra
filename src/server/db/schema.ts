import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const attendanceStatusEnum = pgEnum("attendance_status", [
  "open",
  "closed",
]);
export const entryStatusEnum = pgEnum("entry_status", [
  "active",
  "paused",
  "completed",
]);
export const entrySourceEnum = pgEnum("entry_source", ["timer", "manual"]);
export const reviewStateEnum = pgEnum("review_state", [
  "draft",
  "ready",
  "reviewed",
  "synced",
  "changed_after_sync",
]);
export const syncStatusEnum = pgEnum("sync_status", [
  "pending",
  "success",
  "failed",
]);

export const agentActionStatusEnum = pgEnum("agent_action_status", [
  "pending",
  "executing",
  "executed",
  "failed",
  "rejected",
  "expired",
]);

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  googleId: text("google_id").unique(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  image: text("image"),
  timezone: text("timezone").notNull(),
  googleAccessToken: text("google_access_token"),
  googleRefreshToken: text("google_refresh_token"),
  googleTokenExpiresAt: timestamp("google_token_expires_at", {
    withTimezone: true,
    mode: "date",
  }),
  /** Space-separated OAuth scopes granted at the last Google sign-in. */
  googleScopes: text("google_scopes"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

export const categories = pgTable("categories", {
  id: uuid("id").defaultRandom().primaryKey(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id),
    status: text("status").notNull().default("todo"),
    priority: text("priority").notNull().default("medium"),
    description: text("description"),
    isFavorite: boolean("is_favorite").notNull().default(false),
    dueAt: timestamp("due_at", { withTimezone: true, mode: "date" }),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique("tasks_user_name_unique").on(t.userId, t.name)],
);

export const dailyAttendance = pgTable(
  "daily_attendance",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workDate: date("work_date", { mode: "string" }).notNull(),
    clockInAt: timestamp("clock_in_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    clockOutAt: timestamp("clock_out_at", {
      withTimezone: true,
      mode: "date",
    }),
    status: attendanceStatusEnum("status").notNull().default("open"),
    reviewState: reviewStateEnum("review_state").notNull().default("draft"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: "date" }),
    lastSyncedAt: timestamp("last_synced_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique("daily_attendance_user_date_unique").on(t.userId, t.workDate)],
);

export const breakEntries = pgTable("break_entries", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  attendanceId: uuid("attendance_id")
    .notNull()
    .references(() => dailyAttendance.id, { onDelete: "cascade" }),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true, mode: "date" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

export const timeEntries = pgTable("time_entries", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  taskId: uuid("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  categoryId: uuid("category_id")
    .notNull()
    .references(() => categories.id),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true, mode: "date" }),
  status: entryStatusEnum("status").notNull().default("active"),
  pausedAt: timestamp("paused_at", { withTimezone: true, mode: "date" }),
  pausedSeconds: integer("paused_seconds").notNull().default(0),
  notes: text("notes"),
  source: entrySourceEnum("source").notNull().default("timer"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

export const spreadsheetConfigs = pgTable("spreadsheet_configs", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  spreadsheetId: text("spreadsheet_id").notNull(),
  worksheetName: text("worksheet_name").notNull(),
  sheetGid: text("sheet_gid"),
  mapping: jsonb("mapping").notNull(),
  timezone: text("timezone").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

export const syncLogs = pgTable("sync_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  workDate: date("work_date", { mode: "string" }).notNull(),
  spreadsheetConfigId: uuid("spreadsheet_config_id").references(
    () => spreadsheetConfigs.id,
    { onDelete: "set null" },
  ),
  status: syncStatusEnum("status").notNull().default("pending"),
  payloadHash: text("payload_hash"),
  changedCells: jsonb("changed_cells"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

export const calendarConfigs = pgTable("calendar_configs", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  calendarId: text("calendar_id").notNull().default("primary"),
  calendarName: text("calendar_name").notNull().default("Primary"),
  syncEnabled: boolean("sync_enabled").notNull().default(true),
  categoryRules: jsonb("category_rules"),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true, mode: "date" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

export const calendarEvents = pgTable(
  "calendar_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    calendarId: text("calendar_id").notNull().default("primary"),
    googleEventId: text("google_event_id"),
    title: text("title").notNull(),
    description: text("description"),
    categoryId: uuid("category_id").references(() => categories.id, {
      onDelete: "set null",
    }),
    startAt: timestamp("start_at", { withTimezone: true, mode: "date" }).notNull(),
    endAt: timestamp("end_at", { withTimezone: true, mode: "date" }).notNull(),
    allDay: boolean("all_day").notNull().default(false),
    meetUrl: text("meet_url"),
    guests: jsonb("guests"),
    sendUpdates: text("send_updates").notNull().default("all"),
    htmlLink: text("html_link"),
    status: text("status").notNull().default("confirmed"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("calendar_events_user_start_idx").on(t.userId, t.startAt),
    unique("calendar_events_user_google_event_unique").on(t.userId, t.googleEventId),
  ],
);


export const apiTokens = pgTable(
  "api_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    tokenPrefix: text("token_prefix").notNull(),
    scopes: text("scopes").array().notNull().default(sql`'{read}'::text[]`),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("api_tokens_user_idx").on(t.userId),
    check("api_tokens_scopes_nonempty", sql`cardinality(${t.scopes}) > 0`),
  ],
);

export const agentActions = pgTable(
  "agent_actions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenId: uuid("token_id").references(() => apiTokens.id, {
      onDelete: "set null",
    }),
    kind: text("kind").notNull(),
    targetType: text("target_type").notNull(),
    targetId: uuid("target_id"),
    summary: jsonb("summary").notNull(),
    reason: text("reason"),
    status: agentActionStatusEnum("status").notNull().default("executed"),
    result: jsonb("result"),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    claimedAt: timestamp("claimed_at", { withTimezone: true, mode: "date" }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "agent_actions_pending_expires",
      sql`${t.status} <> 'pending' OR ${t.expiresAt} IS NOT NULL`,
    ),
    check(
      "agent_actions_executing_claimed",
      sql`${t.status} <> 'executing' OR ${t.claimedAt} IS NOT NULL`,
    ),
    index("agent_actions_user_status_idx").on(t.userId, t.status),
    index("agent_actions_user_created_idx").on(t.userId, t.createdAt),
    uniqueIndex("agent_actions_pending_target_unique")
      .on(t.userId, t.targetType, t.targetId)
      .where(sql`${t.status} = 'pending'`),
  ],
);
