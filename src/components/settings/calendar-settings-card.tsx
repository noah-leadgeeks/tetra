"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  AlertCircle,
  Calendar,
  CheckCircle2,
  ChevronDown,
  Loader2,
  RefreshCw,
  Sparkles,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { apiFetch } from "@/components/timeline/api";
import type {
  CalendarConfigDTO,
  CalendarItemDTO,
} from "@/features/calendar-sync/types";
import { DEFAULT_CATEGORY_RULES } from "@/features/calendar-sync/rules";
import { cn } from "@/lib/utils";

interface CalendarConfigResponse {
  config: CalendarConfigDTO;
  calendars: CalendarItemDTO[];
}

export function CalendarSettingsCard() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [config, setConfig] = useState<CalendarConfigDTO | null>(null);
  const [calendars, setCalendars] = useState<CalendarItemDTO[]>([]);
  const [selectedCalendarId, setSelectedCalendarId] = useState<string>("primary");
  const [syncEnabled, setSyncEnabled] = useState<boolean>(true);
  const [showRules, setShowRules] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await apiFetch<CalendarConfigResponse>("/api/calendar/config");
        if (cancelled) return;
        setConfig(res.config);
        setCalendars(res.calendars || []);
        setSelectedCalendarId(res.config?.calendarId || "primary");
        setSyncEnabled(res.config?.syncEnabled ?? true);
      } catch (err) {
        if (!cancelled) {
          setLoadError(
            err instanceof Error ? err.message : "Failed to load calendar settings",
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleRefreshCalendars() {
    setTesting(true);
    setLoadError(null);
    try {
      const res = await apiFetch<CalendarConfigResponse>("/api/calendar/config");
      setConfig(res.config);
      setCalendars(res.calendars || []);
      setSelectedCalendarId(res.config?.calendarId || "primary");
      setSyncEnabled(res.config?.syncEnabled ?? true);
      toast.success("Calendar list refreshed.");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to refresh calendars.",
      );
    } finally {
      setTesting(false);
    }
  }

  async function handleSave(e?: React.FormEvent) {
    if (e) e.preventDefault();
    setSaving(true);
    try {
      const selectedCalendar = calendars.find(
        (c) => c.id === selectedCalendarId,
      );
      const updated = await apiFetch<CalendarConfigDTO>("/api/calendar/config", {
        method: "POST",
        body: JSON.stringify({
          calendarId: selectedCalendarId,
          calendarName: selectedCalendar?.summary || "Primary",
          syncEnabled,
        }),
      });

      setConfig(updated);
      setSelectedCalendarId(updated.calendarId);
      setSyncEnabled(updated.syncEnabled);
      toast.success("Google Calendar settings saved.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save settings.");
    } finally {
      setSaving(false);
    }
  }

  const isConnected = config?.hasGoogleAuth ?? false;

  return (
    <Card className="shadow-xs border-border/80" data-testid="calendar-settings-card">
      <CardHeader>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Calendar className="size-5" />
            </div>
            <div>
              <CardTitle>Google Calendar Integration</CardTitle>
              <CardDescription>
                Surface scheduled meetings on your Today screen and import them directly into TETRA.
              </CardDescription>
            </div>
          </div>

          <div>
            {isConnected ? (
              <Badge
                variant="outline"
                className="gap-1.5 border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 font-medium py-1 px-2.5"
              >
                <CheckCircle2 className="size-3.5 text-emerald-600 dark:text-emerald-400" />
                Google Connected
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="gap-1.5 border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400 font-medium py-1 px-2.5"
              >
                <AlertCircle className="size-3.5 text-amber-500" />
                Auth Required
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent>
        {loading ? (
          <div className="grid gap-3" aria-label="Loading calendar settings" data-loading="true">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-11 animate-pulse rounded-lg bg-muted/60"
                aria-hidden
              />
            ))}
          </div>
        ) : (
          <form onSubmit={handleSave} className="grid gap-6">
            {loadError && (
              <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
                <AlertCircle className="size-4 shrink-0" />
                <span>{loadError}</span>
              </div>
            )}

            {isConnected && config && !config.canWriteGoogle && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3.5 text-xs text-muted-foreground">
                Reconnect Google (sign out and in) to enable calendar edits
              </div>
            )}

            {!isConnected && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3.5 text-xs text-muted-foreground">
                <p className="font-semibold text-foreground mb-1">
                  Google Calendar OAuth scope needed
                </p>
                <p>
                  To read your events, sign in with Google or ensure you have authorized
                  the calendar scope. Once connected, your primary and secondary calendars will be listed below.
                </p>
              </div>
            )}

            <div className="grid gap-5">
              {/* Calendar Selector */}
              <div className="grid gap-2">
                <Label htmlFor="calendar-select" className="text-sm font-medium">
                  Select Calendar
                </Label>
                <div className="flex flex-col sm:flex-row gap-2.5 items-start sm:items-center">
                  <Select
                    value={selectedCalendarId}
                    onValueChange={setSelectedCalendarId}
                    disabled={!isConnected || saving || calendars.length === 0}
                  >
                    <SelectTrigger id="calendar-select" className="h-11 w-full sm:max-w-md text-sm">
                      <SelectValue placeholder="Choose a calendar" />
                    </SelectTrigger>
                    <SelectContent>
                      {calendars.length > 0 ? (
                        calendars.map((cal) => (
                          <SelectItem key={cal.id} value={cal.id} className="text-xs">
                            <span className="font-medium">{cal.summary}</span>
                            {cal.primary && (
                              <span className="text-muted-foreground ml-1.5 text-[11px]">
                                (Primary)
                              </span>
                            )}
                          </SelectItem>
                        ))
                      ) : (
                        <SelectItem value="primary" className="text-xs">
                          Primary Calendar
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>

                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-11 px-3 text-xs gap-1.5 shrink-0"
                    onClick={handleRefreshCalendars}
                    disabled={testing || saving}
                    title="Refresh available calendars"
                  >
                    <RefreshCw className={cn("size-3.5", testing && "animate-spin")} />
                    Refresh List
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Events from this calendar will appear on your Today screen for quick review.
                </p>
              </div>

              {/* Toggle Enable/Disable Suggestions */}
              <div className="flex items-center justify-between gap-4 rounded-xl border border-border/70 bg-card p-4">
                <div className="space-y-0.5">
                  <Label htmlFor="sync-toggle" className="text-sm font-medium cursor-pointer">
                    Enable Calendar Suggestions on Today Screen
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    When enabled, TETRA surfaces your morning schedule and lets you import events in one click.
                  </p>
                </div>
                <Switch
                  id="sync-toggle"
                  checked={syncEnabled}
                  onCheckedChange={setSyncEnabled}
                  disabled={saving}
                  data-testid="calendar-sync-toggle"
                />
              </div>

              {/* Category Rules Reference Info */}
              <div className="rounded-xl border border-border/60 bg-muted/20 p-4">
                <button
                  type="button"
                  className="flex items-center justify-between w-full text-left cursor-pointer"
                  onClick={() => setShowRules((prev) => !prev)}
                >
                  <div className="flex items-center gap-2">
                    <Sparkles className="size-4 text-primary" />
                    <span className="text-xs font-semibold text-foreground">
                      Smart Category Classification
                    </span>
                  </div>
                  <span className="text-xs text-primary font-medium flex items-center gap-1">
                    {showRules ? "Hide details" : "View keyword rules"}
                    <ChevronDown
                      className={cn("size-3.5 transition-transform", showRules && "rotate-180")}
                    />
                  </span>
                </button>

                {showRules && (
                  <div className="mt-3 pt-3 border-t border-border/50 text-xs space-y-2">
                    <p className="text-muted-foreground">
                      TETRA inspects event titles and descriptions using word-boundary keywords to auto-select the best matching category before import:
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                      {DEFAULT_CATEGORY_RULES.map((rule) => (
                        <div
                          key={rule.categoryKey}
                          className="rounded-md border border-border/40 bg-background/60 p-2 text-[11px]"
                        >
                          <span className="font-semibold text-foreground">
                            {rule.categoryName}:
                          </span>{" "}
                          <span className="text-muted-foreground">
                            {rule.keywords.slice(0, 5).join(", ")}
                            {rule.keywords.length > 5 ? "…" : ""}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex items-center gap-3 pt-2">
              <Button
                type="submit"
                className="h-11 px-6 font-medium shadow-xs"
                disabled={saving}
                data-testid="calendar-settings-save"
              >
                {saving ? (
                  <>
                    <Loader2 className="mr-2 size-4 animate-spin" />
                    Saving…
                  </>
                ) : (
                  "Save Calendar Settings"
                )}
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
