"use client";

import { useEffect, useState } from "react";
import {
  Calendar as CalendarIcon,
  ExternalLink,
  Loader2,
  Mail,
  Plus,
  Trash2,
  Users,
  Video,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { CategoryBadge } from "@/components/ui/category-badge";
import type { CalendarEventDTO, GoogleSyncResult } from "@/features/calendar-sync/types";
import { cn } from "@/lib/utils";

interface CategoryOption {
  id: string;
  key: string;
  name: string;
}

interface EventDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  event?: CalendarEventDTO | null;
  initialDate?: string; // YYYY-MM-DD
  categories?: CategoryOption[];
  /** False when the user never connected Google: no Google warning is shown then. */
  hasGoogleAuth?: boolean;
  onSaved?: (event: CalendarEventDTO) => void;
  onDeleted?: (eventId: string) => void;
}

function warnIfGoogleNotSynced(google: GoogleSyncResult | undefined, hasGoogleAuth: boolean) {
  // Users without Google auth have nothing to sync; the warning would be noise.
  if (!hasGoogleAuth || !google || google.synced || !google.error) return;
  toast.warning(
    google.error === "missing_scope"
      ? "Saved in TETRA only. Reconnect Google (sign out and in) to enable calendar edits."
      : google.error === "not_linked"
        ? "Saved in TETRA only. This event is not linked to Google Calendar."
        : `Saved in TETRA, but Google Calendar was not updated: ${google.error}`,
  );
}

export function EventDialog(props: EventDialogProps) {
  if (!props.open) return null;
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <EventDialogInner
        key={props.event?.id ?? props.initialDate ?? "new"}
        {...props}
      />
    </Dialog>
  );
}

function EventDialogInner({
  onOpenChange,
  event,
  initialDate,
  categories: initialCategories,
  hasGoogleAuth = true,
  onSaved,
  onDeleted,
}: EventDialogProps) {
  const isEditing = Boolean(event);

  const [categories, setCategories] = useState<CategoryOption[]>(initialCategories || []);

  // Compute initial form state without needing useEffect setState
  const initDate = () => {
    if (event) {
      return new Date(event.startAt).toISOString().split("T")[0];
    }
    return initialDate || new Date().toISOString().split("T")[0];
  };

  const initStartTime = () => {
    if (event) {
      const s = new Date(event.startAt);
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${pad(s.getHours())}:${pad(s.getMinutes())}`;
    }
    return "10:00";
  };

  const initEndTime = () => {
    if (event) {
      const e = new Date(event.endAt);
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${pad(e.getHours())}:${pad(e.getMinutes())}`;
    }
    return "11:00";
  };

  const [title, setTitle] = useState(event?.title || "");
  const [dateStr, setDateStr] = useState(initDate);
  const [startTime, setStartTime] = useState(initStartTime);
  const [endTime, setEndTime] = useState(initEndTime);
  const [allDay, setAllDay] = useState(event?.allDay ?? false);
  const [categoryId, setCategoryId] = useState<string>(event?.categoryId || "");
  const [description, setDescription] = useState(event?.description || "");
  const [guestInput, setGuestInput] = useState("");
  const [guests, setGuests] = useState<string[]>(
    event?.guests ? event.guests.map((g) => g.email) : [],
  );
  const [createMeet, setCreateMeet] = useState(event ? Boolean(event.meetUrl) : true);
  const [sendUpdates, setSendUpdates] = useState(event ? event.sendUpdates === "all" : true);

  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Load categories if not provided
  useEffect(() => {
    if (categories.length > 0) return;
    let active = true;
    async function loadCats() {
      try {
        const res = await fetch("/api/categories");
        if (!res.ok) return;
        const data = await res.json();
        if (active && Array.isArray(data)) {
          setCategories(data);
          if (!categoryId) {
            const meetingCat = data.find((c: CategoryOption) => c.key === "meeting") || data[0];
            if (meetingCat) setCategoryId(meetingCat.id);
          }
        }
      } catch (e) {
        console.error("Failed to load categories for event dialog", e);
      }
    }
    void loadCats();
    return () => {
      active = false;
    };
  }, [categories.length, categoryId]);

  function handleAddGuest() {
    const email = guestInput.trim().toLowerCase();
    if (!email) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setErrorMessage("Please enter a valid email address.");
      return;
    }
    if (guests.includes(email)) {
      setGuestInput("");
      return;
    }
    setGuests([...guests, email]);
    setGuestInput("");
    setErrorMessage(null);
  }

  function handleRemoveGuest(emailToRemove: string) {
    setGuests(guests.filter((e) => e !== emailToRemove));
  }

  async function handleSave() {
    if (!title.trim()) {
      setErrorMessage("Please provide an event title.");
      return;
    }
    if (!dateStr) {
      setErrorMessage("Please select a date.");
      return;
    }

    setSaving(true);
    setErrorMessage(null);

    try {
      let startIso: string;
      let endIso: string;

      if (allDay) {
        startIso = `${dateStr}T00:00:00.000Z`;
        endIso = `${dateStr}T23:59:59.999Z`;
      } else {
        const startDate = new Date(`${dateStr}T${startTime}:00`);
        const endDate = new Date(`${dateStr}T${endTime}:00`);

        if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
          throw new Error("Invalid time format.");
        }
        if (endDate <= startDate) {
          throw new Error("End time must be after start time.");
        }

        startIso = startDate.toISOString();
        endIso = endDate.toISOString();
      }

      const payload = {
        title: title.trim(),
        description: description.trim() || null,
        categoryId: categoryId || null,
        startAt: startIso,
        endAt: endIso,
        allDay,
        guests,
        createMeet,
        sendUpdates: sendUpdates ? "all" : "none",
      };

      if (isEditing && event) {
        const res = await fetch(`/api/calendar/events/${event.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || "Failed to update calendar event");
        }

        const data = await res.json();
        toast.success("Event updated successfully", {
          description: createMeet && data.event?.meetUrl ? "Google Meet conference updated." : undefined,
        });
        warnIfGoogleNotSynced(data.google, hasGoogleAuth);
        onSaved?.(data.event);
        onOpenChange(false);
      } else {
        const res = await fetch("/api/calendar/events", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || "Failed to create calendar event");
        }

        const data = await res.json();
        toast.success("Event created successfully", {
          description: createMeet && data.event?.meetUrl ? "Google Meet link generated." : undefined,
        });
        warnIfGoogleNotSynced(data.google, hasGoogleAuth);
        onSaved?.(data.event);
        onOpenChange(false);
      }
    } catch (err) {
      console.error("Save event error:", err);
      setErrorMessage(err instanceof Error ? err.message : "Failed to save event");
      toast.error(err instanceof Error ? err.message : "Failed to save event");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!event) return;
    if (!confirm("Are you sure you want to delete this event? This will also remove it from Google Calendar.")) {
      return;
    }

    setDeleting(true);
    setErrorMessage(null);

    try {
      const res = await fetch(`/api/calendar/events/${event.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to delete event");
      }

      const data = (await res.json().catch(() => ({}))) as { google?: GoogleSyncResult };
      toast.success("Event deleted");
      warnIfGoogleNotSynced(data.google, hasGoogleAuth);
      onDeleted?.(event.id);
      onOpenChange(false);
    } catch (err) {
      console.error("Delete event error:", err);
      setErrorMessage(err instanceof Error ? err.message : "Failed to delete event");
      toast.error("Could not delete event");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <DialogContent className="sm:max-w-xl max-h-[92vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <CalendarIcon className="size-5 text-primary" />
          {isEditing ? "Edit Calendar Event" : "Create Calendar Event"}
        </DialogTitle>
        <DialogDescription>
          {isEditing
            ? "Update event schedule, guests, and Google Meet link."
            : "Schedule a task or meeting with Google Meet and guest invitations."}
        </DialogDescription>
      </DialogHeader>

      {errorMessage && (
        <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-3 text-xs text-destructive flex items-center gap-2">
          <span>{errorMessage}</span>
        </div>
      )}

      <div className="space-y-4 py-2">
        {/* Title */}
        <div className="space-y-1.5">
          <Label htmlFor="event-title" className="text-xs font-semibold text-foreground/80">
            Title <span className="text-destructive">*</span>
          </Label>
          <Input
            id="event-title"
            placeholder="e.g. Team Project Meeting"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={saving || deleting}
            autoFocus
            className="text-sm font-medium"
          />
        </div>

        {/* Date & Time Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="space-y-1.5 sm:col-span-1">
            <Label htmlFor="event-date" className="text-xs font-semibold text-foreground/80">
              Date
            </Label>
            <Input
              id="event-date"
              type="date"
              value={dateStr}
              onChange={(e) => setDateStr(e.target.value)}
              disabled={saving || deleting}
              className="text-xs"
            />
          </div>

          {!allDay && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="event-start" className="text-xs font-semibold text-foreground/80">
                  Start
                </Label>
                <Input
                  id="event-start"
                  type="time"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  disabled={saving || deleting}
                  className="text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="event-end" className="text-xs font-semibold text-foreground/80">
                  End
                </Label>
                <Input
                  id="event-end"
                  type="time"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  disabled={saving || deleting}
                  className="text-xs"
                />
              </div>
            </>
          )}
        </div>

        {/* All day toggle & Quick time helpers */}
        <div className="flex items-center justify-between pt-1">
          <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={allDay}
              onChange={(e) => setAllDay(e.target.checked)}
              className="rounded border-input text-primary focus:ring-primary size-3.5"
            />
            <span>All-day event</span>
          </label>

          {!allDay && (
            <div className="flex items-center gap-1.5">
              {[
                { label: "30m", minutes: 30 },
                { label: "1h", minutes: 60 },
                { label: "1.5h", minutes: 90 },
              ].map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => {
                    const [sh, sm] = startTime.split(":").map(Number);
                    const sTotal = sh * 60 + sm;
                    const eTotal = sTotal + preset.minutes;
                    const eh = Math.floor((eTotal % (24 * 60)) / 60);
                    const em = eTotal % 60;
                    const pad = (n: number) => String(n).padStart(2, "0");
                    setEndTime(`${pad(eh)}:${pad(em)}`);
                  }}
                  className="text-[11px] px-2 py-0.5 rounded border border-border/70 hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                >
                  +{preset.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Category */}
        <div className="space-y-1.5">
          <Label className="text-xs font-semibold text-foreground/80">
            Category
          </Label>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {categories.map((cat) => {
              const selected = categoryId === cat.id;
              return (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => setCategoryId(cat.id)}
                  className={cn(
                    "flex items-center gap-1.5 p-2 rounded-lg border text-left text-xs transition-all select-none cursor-pointer",
                    selected
                      ? "border-primary/60 bg-primary/10 text-primary font-semibold shadow-xs"
                      : "border-border/60 hover:border-border hover:bg-muted/40 text-muted-foreground hover:text-foreground",
                  )}
                >
                  <CategoryBadge
                    categoryKey={cat.key}
                    categoryName={cat.name}
                    showIcon={false}
                    size="sm"
                    className="px-1.5 py-0 border-0 bg-transparent text-[11px]"
                  />
                </button>
              );
            })}
          </div>
        </div>

        {/* Description */}
        <div className="space-y-1.5">
          <Label htmlFor="event-description" className="text-xs font-semibold text-foreground/80">
            Description / Agenda
          </Label>
          <Textarea
            id="event-description"
            placeholder="Add agenda, meeting link notes, or deliverables..."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={saving || deleting}
            rows={2}
            className="text-xs resize-none"
          />
        </div>

        {/* Guests / Attendees */}
        <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-3">
          <div className="flex items-center justify-between">
            <Label className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
              <Users className="size-3.5 text-primary" />
              <span>Guests ({guests.length})</span>
            </Label>
            <span className="text-[11px] text-muted-foreground">Press enter to add email</span>
          </div>

          <div className="flex gap-2">
            <div className="relative flex-1">
              <Mail className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
              <Input
                placeholder="colleague@company.com"
                value={guestInput}
                onChange={(e) => setGuestInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleAddGuest();
                  }
                }}
                disabled={saving || deleting}
                className="pl-8 text-xs h-8"
              />
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleAddGuest}
              disabled={saving || deleting || !guestInput.trim()}
              className="h-8 px-3 text-xs gap-1"
            >
              <Plus className="size-3.5" />
              Add
            </Button>
          </div>

          {guests.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {guests.map((email) => (
                <span
                  key={email}
                  className="inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground border border-border/50"
                >
                  <span className="truncate max-w-[200px]">{email}</span>
                  <button
                    type="button"
                    onClick={() => handleRemoveGuest(email)}
                    className="text-muted-foreground hover:text-foreground rounded-full hover:bg-muted p-0.5 transition-colors"
                    title="Remove guest"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Video Meeting Section (User ASCII Mockup) */}
        <div className="rounded-xl border border-primary/20 bg-primary/[0.03] p-3.5 space-y-2.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="p-1.5 rounded-lg bg-primary/10 text-primary">
                <Video className="size-4" />
              </div>
              <div>
                <div className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                  <span>Google Meet</span>
                  {createMeet && (
                    <span className="text-[10px] bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 font-medium px-1.5 py-0.2 rounded-full">
                      Automated
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  Create meeting automatically via Google Calendar API
                </div>
              </div>
            </div>
            <Switch
              checked={createMeet}
              onCheckedChange={setCreateMeet}
              disabled={saving || deleting}
            />
          </div>

          {/* Meet URL preview if already present */}
          {event?.meetUrl && (
            <div className="mt-2 pt-2 border-t border-primary/10 flex items-center justify-between text-xs">
              <a
                href={event.meetUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-[11px] text-primary hover:underline truncate max-w-[280px] flex items-center gap-1"
              >
                <ExternalLink className="size-3" />
                {event.meetUrl}
              </a>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 text-[11px] gap-1 px-2 text-primary border-primary/30"
                onClick={() => window.open(event.meetUrl!, "_blank")}
              >
                Join Meeting
              </Button>
            </div>
          )}
        </div>

        {/* Notifications Toggle */}
        <div className="flex items-center justify-between px-1">
          <label className="flex items-center gap-2 text-xs text-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={sendUpdates}
              onChange={(e) => setSendUpdates(e.target.checked)}
              className="rounded border-input text-primary focus:ring-primary size-3.5"
            />
            <span className="font-medium">Send invitations to guests</span>
            <span className="text-[11px] text-muted-foreground font-mono">
              (sendUpdates: {sendUpdates ? "all" : "none"})
            </span>
          </label>
        </div>
      </div>

      <DialogFooter className="flex flex-row items-center justify-between gap-2 pt-3 border-t border-border/60">
        <div>
          {isEditing && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleDelete}
              disabled={saving || deleting}
              className="text-destructive hover:text-destructive hover:bg-destructive/10 text-xs gap-1.5"
            >
              {deleting ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Trash2 className="size-3.5" />
              )}
              Delete
            </Button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={saving || deleting}
            className="text-xs"
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={handleSave}
            disabled={saving || deleting}
            className="text-xs gap-1.5 font-medium shadow-sm"
          >
            {saving ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                {isEditing ? "Saving..." : "Creating..."}
              </>
            ) : isEditing ? (
              "Save Changes"
            ) : (
              "Create Event"
            )}
          </Button>
        </div>
      </DialogFooter>
    </DialogContent>
  );
}
