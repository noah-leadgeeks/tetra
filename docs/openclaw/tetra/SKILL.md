---
name: tetra
description: Read and update the user's Tetra time-tracking data (day summary, tasks, schedule, calendar events, attendance, timers, breaks) through the Tetra agent API. Use when the user asks about their day, tasks, schedule or hours, or wants to start/stop a timer, clock in/out, or add/edit/delete tasks, entries, breaks or calendar events.
---

# Tetra agent API

Env (never print or echo the token): `TETRA_BASE_URL` (e.g. `https://tetra.example.com`), `TETRA_API_TOKEN`.

```bash
H=(-H "Authorization: Bearer $TETRA_API_TOKEN" -H "Content-Type: application/json")
curl -s "${H[@]}" "$TETRA_BASE_URL/api/agent/summary"
```

All paths are under `/api/agent`. Responses are JSON, never cached. Do not poll faster than every 15 s.

## Rules
- Before any POST/PATCH/DELETE: restate the exact change and ask the user to confirm in chat. Only call after a yes.
- Dates are the user's local day (`YYYY-MM-DD`). Instants must be ISO 8601 **with** an offset (`2026-10-12T09:00:00+07:00` or `...Z`); naive timestamps get 400.
- Task due dates: send `dueDate: "YYYY-MM-DD"` (user's local date), `null` clears it. `dueAt` is rejected (400). Task bodies reject unknown fields.
- `taskName` / task `name` must not start with `=`, `+`, `-`, `@`, tab or carriage return (spreadsheet formula injection guard); such values get 400. Rephrase (e.g. "Fix -1 bug" is fine, "-1 bug" is not).
- Categories are given by `categoryKey` (or `categoryId`); list them first.

## Reads (token needs any scope)
```bash
GET /summary?sync=true            # sync optional: refresh events from Google
GET /tasks?filter=open&days=7&limit=50   # filter: today|overdue|in_progress|upcoming|open|all (default open); days 1-90; limit 1-200
GET /tasks/{id}
GET /schedule?date=2026-10-12     # date optional, default today
GET /calendar/events?date=...  or  ?from=<instant>&to=<instant>  (&sync=true)
GET /attendance?date=...
GET /time-entries?date=...        # entries for the day
GET /time-entries/active          # running/paused entry or null
GET /categories
GET /actions?status=pending&limit=50   # your delete requests
```
Response glossary:
- `summary`: `date`, `timezone`, `now`, `attendance` (`status`, `clockInAt`, `clockOutAt`, `breakMinutes`, `activeBreak`) or null, `activeEntry` or null, `totals`, `tasks.{inProgress,dueToday,overdue,upcoming}`, `schedule[]` (`id,title,startAt,endAt,allDay,meetUrl`), `warnings[]` (`type,message`), `needsSync`.
- task item: `id,name,status,priority,categoryKey,dueDate,description`. List returns `{date, filter, tasks}`; `GET /tasks/{id}` returns the full task (adds `isFavorite,categoryId,categoryName,dueAt,startedAt,completedAt,createdAt`).
- entry item: `id,taskId,taskName,categoryKey,startedAt,endedAt,status,durationMinutes,notes`.
- `schedule`: `date, attendance, breaks, timeEntries, events, totals, warnings, reviewState, needsSync`. `calendar/events`: `{date, from, to, events}`. `attendance`: `{date, attendance}`. `categories`: `[{id,key,name}]`.

## Updates (token needs `write`; confirm in chat first)
```bash
POST  /tasks                 {"name":"Write report","categoryKey":"dev","dueDate":"2026-10-14","priority":"high","status":"todo","description":"..."}   # 201 {task}; name + category required
PATCH /tasks/{id}            {"status":"done","dueDate":null}      # name,status,priority,description,isFavorite,categoryKey|categoryId,dueDate,startedAt,completedAt -> {task}
POST  /time-entries/start    {"taskName":"Review PR","categoryKey":"dev","notes":"..."}   # auto-stops a running entry -> {entry, sheetSync}
POST  /time-entries/pause    POST /time-entries/resume    POST /time-entries/stop       # no body -> {entry}
POST  /time-entries          {"taskName":"Standup","categoryKey":"meeting","startedAt":"2026-10-12T09:00:00+07:00","endedAt":"2026-10-12T09:15:00+07:00","notes":""}   # 201 {entry, sheetSync}
PATCH /time-entries/{id}     {"endedAt":"...","notes":"...","taskName":"...","categoryKey":"..."}   # {entry, sheetSync}
POST  /attendance/clock-in   POST /attendance/clock-out     # body {} -> {attendance, autoSync}
PATCH /attendance/{date}     {"clockInAt":"...+07:00","clockOutAt":"...+07:00","status":"closed"}   # status open|closed; times nullable -> {attendance, autoSync}
POST  /breaks/start          POST /breaks/stop              # body {} -> {attendance[, sheetSync]}
POST  /breaks                {"workDate":"2026-10-12","startedAt":"...","endedAt":"..."}   # 201 {break, sheetSync}
PATCH /breaks/{id}           {"startedAt":"...","endedAt":"..."}    # {break, sheetSync}
POST  /calendar/events       {"title":"Sync","startAt":"...","endAt":"...","description":"","allDay":false,"guests":["a@b.com"],"createMeet":true,"sendUpdates":"none"}   # 201 {event, google}
PATCH /calendar/events/{id}  {"title":"...","startAt":"...","endAt":"..."}    # {event, google}
```
- `google` = `{synced, error}`. If `synced` is false, tell the user Google Calendar was NOT updated (`error`: `not_linked`, `missing_scope`, or a Google message); the local event was still saved.
- `sheetSync` / `autoSync` report the spreadsheet sync (`attempted`, `success`, `code`, `message`). If `success` is false, tell the user. Clock-out may mark the day reviewed automatically.
- Overlapping time entries return 409.
- Editing or deleting a calendar event that has guests notifies them according to the event's stored `sendUpdates` (`all` or `none`; an explicit `sendUpdates` on PATCH overrides it). Ask the user before changing or deleting events with guests.

## Deletes (token needs `delete`)
Supported: `DELETE /tasks/{id}`, `/time-entries/{id}`, `/breaks/{id}`, `/calendar/events/{id}`. Optional body: `{"reason":"...","expiresInMinutes":60}` (default and max 1440).
```bash
curl -s -X DELETE "${H[@]}" -d '{"reason":"duplicate"}' "$TETRA_BASE_URL/api/agent/tasks/$ID"
```
Repeating a DELETE for a target that already has a pending action returns that same action. DELETE returns **202** with `{action:{id,status:"pending",kind,target:{type,id,label},impact,reason,createdAt,expiresAt,approvePath,approveUrl},message}`; nothing is deleted yet. Then:
1. Tell the user to approve it in Tetra (Settings -> Agent access, or the bell). Link: `TETRA_BASE_URL + action.approvePath`.
2. Poll `GET /actions/{id}` every ~30 s until `expiresAt`. Response `{action}` has `status`, `result`, `resolvedAt`, and (pending only) `stale`.
3. Report the final `status`: `executed`, `rejected`, `expired`, or `failed`. For `failed`, report `result.code`, one of `gone | stale | timeout | token_revoked | expired | execution_error | sync_error` (`result.error` has detail).
4. After an executed task delete, if `result.needsSync` lists days, say: "these days are now marked Not synced in Tetra". Executed entry/break deletes include `result.sheetSync`; calendar deletes include `result.google`.

## Errors
Body is `{error, code}`.
- `401 invalid_token`: missing, wrong or revoked token. `503 auth_unavailable`: retry later.
- `403 insufficient_scope`: token lacks `write`/`delete`; ask the user to create a token with that scope.
- `403 auth_bypass`: Tetra runs with DISABLE_AUTH; agent access is off.
- `400 bad_request`: invalid body/param or a rejected state (message says which, e.g. "No active task", "Already clocked in"). `404 not_found`. `409 conflict` (overlapping time entry, or a transient "retry" on delete registration).
- `500 internal_error`: unexpected server failure with a generic message; the detail is only in server logs. Do not retry blindly; tell the user.
