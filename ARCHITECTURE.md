# TETRA Companion App — Architecture

## System shape

```text
Employee                      Personal agent (OpenClaw)
   ↓ session cookie              ↓ Authorization: Bearer <token>
Next.js Web App
   ├── UI (incl. /settings/agent approvals)
   ├── Server Actions / Route Handlers
   │      └── /api/agent/*  (bearer auth, scopes, deletes → pending approval)
   └── Domain Services
          ├── Attendance
          ├── Activities
          ├── Daily Summary
          ├── Sheets Sync
          └── Agent API (tokens, agent_actions)
   ↓
PostgreSQL

Sheets Sync
   ↓
Google Sheets API
   ↓
Existing Official Google Sheet

n8n
   └── Optional external automation
```

## Stack

- Next.js 16
- React 19
- TypeScript
- App Router
- Tailwind CSS
- shadcn/ui
- PostgreSQL (PGlite embedded in Node.js for local dev/test / remote PostgreSQL)
- Drizzle ORM
- Zod
- Google OAuth
- Google Sheets API
- Vitest
- Playwright
- n8n optional

## Architecture decision

Use a **modular monolith** for MVP. No microservices, event bus, Redis, or desktop agent is required.

## Repository structure

```text
src/
├── app/
├── components/
├── features/
│   ├── attendance/
│   ├── activities/
│   ├── daily-summary/
│   ├── sheets-sync/
│   └── agent-api/
├── server/
│   ├── db/
│   ├── auth/
│   ├── services/
│   └── integrations/
├── lib/
└── tests/

drizzle/
scripts/
docs/adr/
```

## Core entities

```text
User
 ├── DailyAttendance
 ├── TimeEntry
 ├── BreakEntry
 └── Task

Category
 └── Task

SpreadsheetConfig
 └── SyncLog

User
 ├── ApiToken
 └── AgentAction (→ ApiToken, nullable)
```

### TimeEntry

```text
id
userId
taskId
categoryId
startedAt
endedAt
status
notes
source
createdAt
updatedAt
```

### DailyAttendance

```text
id
userId
workDate
clockInAt
clockOutAt
status
```

### SpreadsheetConfig

```text
id
userId
spreadsheetId
worksheetName
mappingJson
timezone
active
```

### SyncLog

```text
id
userId
workDate
spreadsheetConfigId
status
payloadHash
changedCells
errorMessage
createdAt
```

### ApiToken (`api_tokens`)

```text
id
userId
name
tokenHash        sha256 of the plaintext, unique; plaintext is never stored
tokenPrefix      display only
scopes           text[]: read | write | delete (non-empty)
expiresAt
revokedAt
lastUsedAt       throttled to one write per minute
createdAt
```

### AgentAction (`agent_actions`)

```text
id
userId
tokenId          set null when the token row is deleted
kind             e.g. task.update, time_entry.delete
targetType       task | time_entry | calendar_event | break | attendance
targetId
summary          JSONB: label, sanitized request, fingerprint, dayKeys, impact
reason
status           pending | executing | executed | failed | rejected | expired
result           JSONB: code, error, google, sheetSync, needsSync
expiresAt        required when pending
claimedAt        required when executing
resolvedAt
createdAt
```

One table is both the audit log of agent writes and the approval queue for agent deletes. A partial unique index on `(user_id, target_type, target_id) WHERE status = 'pending'` keeps one pending request per target. Expired `pending` rows and `executing` rows claimed more than 5 minutes ago are swept lazily whenever actions are listed, polled, approved or rejected (no cron).

## Agent API

- `/api/agent/*` is a separate namespace from the UI routes. It authenticates only with `Authorization: Bearer <token>` (no cookie fallback) through `withAgentAuth(scope, handler)` in `src/features/agent-api/http.ts`, and calls the same domain services as the UI routes.
- Reads need `read`; creates and updates need `write` and apply directly; deletes need `delete` and only create a `pending` action that the user approves or rejects in `/settings/agent` (session routes `/api/agent-actions/*`). Approval claims `pending → executing` atomically, re-checks the target fingerprint against the one the user saw, deletes, then records `executed` or `failed`. See ADR-0009.
- Agent access, token management and approvals refuse with 403 `auth_bypass` while `DISABLE_AUTH` is on.
- Agent entry/break/timer-stop writes and approved entry/break deletes sync the affected days through `syncDaysAfterChange` (`src/features/sheets-sync/auto-sync-server.ts`) with the Timeline auto-sync gating. Approved task deletes do not sync; their days stay `changed_after_sync`.

## Source of truth

The PostgreSQL database is authoritative for TETRA's raw activities and sync state.

The existing Google Sheet is the official reporting artifact and a synchronized projection.

## Spreadsheet mapping

Never hard-code workbook coordinates throughout the codebase.

Example configuration:

```json
{
  "dateColumn": "A",
  "clockInColumn": "B",
  "breakStartColumn": "C",
  "breakEndColumn": "D",
  "clockOutColumn": "E",
  "dailyTotalColumn": "F",
  "workTotalColumn": "G",
  "categories": {
    "website_management": "EL",
    "cyber_security": "EN",
    "technology_innovation": "EP",
    "infrastructure_management": "ER",
    "research": "FL",
    "meeting": "FN",
    "training": "FP",
    "other_tasks": "FR"
  }
}
```

Treat this as an example only. Production mapping must be verified against the actual workbook.

## Sync flow

```text
Raw entries
  ↓
Calculate summary
  ↓
Validate gaps/overlaps
  ↓
User review
  ↓
Generate payload
  ↓
Hash payload
  ↓
Write mapped cells
  ↓
Record SyncLog
```

Sync must be idempotent and must never overwrite unrelated cells.

### Client auto-sync and the "Not synced" signal

- All client-side background syncs (Timeline saves, Today stop-task/end-break, calendar import) go through `syncDayToSheet` in `src/lib/auto-sync.ts`. Network errors and per-attempt timeouts (45 s) are retried after 1 s and 3 s, waiting for `online` between attempts; a 502 is retried once; other statuses are not retried. Concurrent triggers for a day coalesce into the running sync plus one follow-up. Final failures show a `toast.error` with id `sheet-sync-<day>` (Retry action only for network errors and 502s). With `auto: true`, a `not_configured` 400 (no config, file mode, no credentials) is silent. Retry helpers live in `src/lib/retry.ts`.
- `DaySummaryWithSyncDTO.needsSync` (returned by `getDaySummary` / `GET /api/days/:date`) is derived, with no extra column: `hasAttendance AND (last_synced_at IS NULL OR max(daily_attendance.updated_at, time_entries.updated_at of overlapping entries) > last_synced_at)`. `last_synced_at` is a snapshot of when the synced summary was read (`executeSync` captures `syncedAt` after `getDaySummary`; `markSynced` writes it and does not touch `updated_at`), so edits made during a sync still count as newer.
- Invariant: every mutation that affects a day's sheet output must bump `daily_attendance.updated_at` for each affected local day (`markDaysChanged` in `activities/entry-helpers.ts`, `touchAttendance` in `attendance/service.ts`; task rename/re-categorise/delete fan out to all days with entries for the task). Code that inserts rows during a pull must set `updated_at` explicitly so a pulled day is not flagged.

### Calendar schedule import

The "Schedule -> Review & Import" flow is available on Today and on Timeline (for the viewed day). `importCalendarEvents` is transactional per user: it takes `FOR NO KEY UPDATE` on the user's row (not `FOR UPDATE`, which would deadlock against `startTimer` inserts that take `KEY SHARE` through their FKs), then skips events that already match an entry of the user by title + time (+-2 min). The server checks both the edited `title` and the original `sourceTitle`. Imported days are marked changed (`markDayChanged`). There is no durable link between time entries and calendar events and no schema change.

Known limitations:
- If the user edits the title on the first import (entry stored as "Weekly sync" for event "Sync") and later imports the same event again without editing, neither `title` nor `sourceTitle` ("Sync") matches "Weekly sync" (unless one contains the other), so a duplicate entry is created.
- Renaming the task after import has the same effect, and the schedule card shows the event as "New" again.

Both are accepted consequences of having no durable link.

## Time handling

- Store timestamps in UTC.
- Store the user's IANA timezone.
- Group daily data using the user's timezone.
- Calculate duration server-side.
- Render duration as H:MM.
- Never trust a client-provided duration.

## API examples

```text
POST /api/attendance/start
POST /api/attendance/stop
POST /api/breaks/start
POST /api/breaks/stop

POST /api/time-entries/start
POST /api/time-entries/stop
POST /api/time-entries
PATCH /api/time-entries/:id
DELETE /api/time-entries/:id

GET  /api/days/:date
POST /api/days/:date/review
POST /api/days/:date/sync

GET    /api/agent/summary                 (Bearer, read)
POST   /api/agent/tasks                   (Bearer, write)
DELETE /api/agent/tasks/:id               (Bearer, delete → 202 pending)
GET    /api/agent/actions/:id             (Bearer, read; poll)
POST   /api/agent-actions/:id/approve     (session)
```

## Security

- OAuth secrets server-side only.
- Validate every mutation with Zod.
- Authorize every record by user.
- Audit spreadsheet writes.
- Do not log OAuth tokens or agent API tokens; store agent tokens only as sha256 hashes.
- Agent deletes always require in-app approval; agent access is off under `DISABLE_AUTH`.
- `ALLOW_DEV_LOGIN` is development only (anyone can sign in as any email and mint agent tokens).
- Do not collect unnecessary monitoring data.

## Failure handling

Google API failure:
- Preserve local data.
- Mark day `Ready to Sync`.
- Allow retry.

Post-sync edit:
- Mark `Changed After Sync`.
- Require review before resync.

## n8n boundary

n8n is optional automation, not the core runtime.

Good uses:
- reminders
- weekly summaries
- approved sync workflows
- external integrations

Core timer/attendance must work without n8n.
