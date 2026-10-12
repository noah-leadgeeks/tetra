"use client";

/**
 * Settings — Google Sheets sync configuration (the ONLY place workbook
 * coordinates are entered; ARCHITECTURE.md example mapping is the default)
 * plus the account card. PUT is validated again server-side.
 */
import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { toast } from "sonner";

import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  RefreshCw,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { CalendarSettingsCard } from "@/components/settings/calendar-settings-card";
import { NotificationsSettingsCard } from "@/components/settings/notifications-settings-card";
import { apiFetch, ApiError } from "@/components/timeline/api";
import type { TestReadSpreadsheetResult } from "@/features/sheets-sync/google";
import type { CategoryDTO } from "@/lib/types";

const COLUMN_PATTERN = /^[A-Z]{1,2}$/;

const CATEGORY_KEYS = [
  "website_management",
  "cyber_security",
  "technology_innovation",
  "infrastructure_management",
  "research",
  "meeting",
  "training",
  "other_tasks",
] as const;

type CategoryKey = (typeof CATEGORY_KEYS)[number];

const FALLBACK_CATEGORY_NAMES: Record<CategoryKey, string> = {
  website_management: "Website Management",
  cyber_security: "Cyber Security",
  technology_innovation: "Technology Innovation",
  infrastructure_management: "Infrastructure Management",
  research: "Research",
  meeting: "Meeting",
  training: "Training",
  other_tasks: "Other Tasks",
};

/** ARCHITECTURE.md example mapping — prefilled, never hard-coded elsewhere. */
const DEFAULT_MAPPING: SheetMappingForm = {
  dateColumn: "A",
  clockInColumn: "B",
  breakStartColumn: "C",
  breakEndColumn: "D",
  clockOutColumn: "E",
  dailyTotalColumn: "F",
  workTotalColumn: "G",
  categories: {
    website_management: "EL",
    cyber_security: "EN",
    technology_innovation: "EP",
    infrastructure_management: "ER",
    research: "FL",
    meeting: "FN",
    training: "FP",
    other_tasks: "FR",
  },
};

interface SheetMappingForm {
  dateColumn: string;
  clockInColumn: string;
  breakStartColumn: string;
  breakEndColumn: string;
  clockOutColumn: string;
  dailyTotalColumn: string;
  workTotalColumn: string;
  categories: Record<CategoryKey, string>;
  categoryNotes?: Record<CategoryKey, string>;
  autoSyncOnClockIn?: boolean;
  autoSyncOnClockOut?: boolean;
  autoSyncTasks?: boolean;
  headerRow?: number;
}

interface SyncConfigForm {
  spreadsheetId: string;
  worksheetName: string;
  sheetGid: string;
  mapping: SheetMappingForm;
  timezone: string;
}

interface SyncConfigResponse {
  spreadsheetId: string | null;
  worksheetName: string | null;
  sheetGid?: string | null;
  mapping: (Partial<SheetMappingForm> & {
    categoryNotes?: Record<CategoryKey, string>;
    autoSyncOnClockIn?: boolean;
    autoSyncOnClockOut?: boolean;
    autoSyncTasks?: boolean;
  }) | null;
  timezone: string | null;
  headerRow?: number;
  notesColumn?: string;
}

interface SettingsViewProps {
  email: string | null;
  name?: string | null;
  image?: string | null;
  hasGoogleAuth?: boolean;
  userTimezone: string;
}

const WORKSHEET_COLUMNS: { key: keyof SheetMappingForm; label: string }[] = [
  { key: "dateColumn", label: "Date" },
  { key: "clockInColumn", label: "Clock in" },
  { key: "breakStartColumn", label: "Break start" },
  { key: "breakEndColumn", label: "Break end" },
  { key: "clockOutColumn", label: "Clock out" },
  { key: "dailyTotalColumn", label: "Daily total" },
  { key: "workTotalColumn", label: "Work total" },
];

function ColumnInput({
  id,
  label,
  value,
  onChange,
  invalid,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  invalid: boolean;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className="text-muted-foreground">
        {label}
      </Label>
      <Input
        id={id}
        className="h-11 w-20 text-center font-mono uppercase"
        value={value}
        onChange={(e) => onChange(e.target.value.toUpperCase())}
        maxLength={2}
        aria-invalid={invalid}
        autoComplete="off"
        spellCheck={false}
      />
    </div>
  );
}

export function SettingsView({
  email,
  name,
  image,
  hasGoogleAuth = false,
  userTimezone,
}: SettingsViewProps) {
  const [form, setForm] = useState<SyncConfigForm>({
    spreadsheetId: "",
    worksheetName: "",
    sheetGid: "",
    mapping: DEFAULT_MAPPING,
    timezone: userTimezone || "Asia/Jakarta",
  });
  const [categoryNames, setCategoryNames] = useState<
    Record<CategoryKey, string>
  >(FALLBACK_CATEGORY_NAMES);
  const [headerRow, setHeaderRow] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [hasSyncConfig, setHasSyncConfig] = useState(false);
  const [togglingAutoSync, setTogglingAutoSync] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<string[]>([]);
  const [testingConnection, setTestingConnection] = useState(false);
  const [testResult, setTestResult] =
    useState<TestReadSpreadsheetResult | null>(null);

  async function handleTestConnection() {
    const spreadsheetId = form.spreadsheetId.trim();
    if (!spreadsheetId || spreadsheetId === "file") {
      toast.error("Enter a Google Spreadsheet ID first");
      return;
    }

    setTestingConnection(true);
    setTestResult(null);
    try {
      const res = await apiFetch<TestReadSpreadsheetResult>(
        "/api/sheets/inspect",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            spreadsheetId: form.spreadsheetId,
            worksheetName: form.worksheetName,
            sheetGid: form.sheetGid,
          }),
        },
      );
      setTestResult(res);
      if (res.ok) {
        toast.success("Spreadsheet read successfully!", {
          description: `Connected to "${res.spreadsheetTitle}" (tab: "${res.targetSheetName}").`,
        });
      } else {
        if (res.authExpired) {
          toast.error("Google session expired. Logging out...");
          const { signOut } = await import("next-auth/react");
          void signOut({ redirectTo: "/login?error=SessionExpired" });
          return;
        }
        toast.error("Could not read spreadsheet", {
          description: res.error,
        });
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        toast.error("Google session expired. Logging out...");
        const { signOut } = await import("next-auth/react");
        void signOut({ redirectTo: "/login?error=SessionExpired" });
        return;
      }
      const message =
        err instanceof Error ? err.message : "Connection failed";
      setTestResult({
        ok: false,
        spreadsheetId: form.spreadsheetId,
        targetSheetName: form.worksheetName,
        targetSheetFound: false,
        sheets: [],
        authMethod: "none",
        error: message,
      });
      toast.error("Connection failed", { description: message });
    } finally {
      setTestingConnection(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [config, categories] = await Promise.all([
          apiFetch<SyncConfigResponse | null>("/api/sync-config"),
          apiFetch<CategoryDTO[]>("/api/categories").catch(() => []),
        ]);
        if (cancelled) return;
        if (categories.length > 0) {
          const names = { ...FALLBACK_CATEGORY_NAMES };
          for (const category of categories) {
            if (category.key in names) {
              names[category.key as CategoryKey] = category.name;
            }
          }
          setCategoryNames(names);
        }
        if (config) {
          setHasSyncConfig(true);
          setForm({
            spreadsheetId: config.spreadsheetId ?? "",
            worksheetName: config.worksheetName ?? "",
            sheetGid: config.sheetGid ?? "",
            mapping: {
              ...DEFAULT_MAPPING,
              ...config.mapping,
              categories: {
                ...DEFAULT_MAPPING.categories,
                ...(config.mapping?.categories ?? {}),
              },
              categoryNotes: config.mapping?.categoryNotes,
              autoSyncOnClockIn: config.mapping?.autoSyncOnClockIn ?? true,
              autoSyncOnClockOut: config.mapping?.autoSyncOnClockOut ?? true,
              autoSyncTasks: config.mapping?.autoSyncTasks ?? true,
            },
            timezone: config.timezone ?? userTimezone ?? "Asia/Jakarta",
          });
          setHeaderRow(config.headerRow);
        }
      } catch (err) {
        if (!cancelled) {
          setLoadError(
            err instanceof Error
              ? err.message
              : "Could not load your sync settings.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [userTimezone]);

  function setColumn(key: keyof SheetMappingForm, value: string) {
    setForm((prev) => ({
      ...prev,
      mapping: { ...prev.mapping, [key]: value },
    }));
  }

  function setCategoryColumn(key: CategoryKey, value: string) {
    setForm((prev) => ({
      ...prev,
      mapping: {
        ...prev.mapping,
        categories: { ...prev.mapping.categories, [key]: value },
      },
    }));
  }

  function validate(): string[] {
    const errors: string[] = [];
    const spreadsheetId = form.spreadsheetId.trim();
    if (spreadsheetId.length > 0 && spreadsheetId.length < 5) {
      errors.push(
        "Spreadsheet ID must be at least 5 characters, or empty for file-only sync.",
      );
    }
    if (form.worksheetName.trim().length === 0) {
      errors.push("Worksheet name is required.");
    }
    if (form.timezone.trim().length === 0) {
      errors.push("Timezone is required.");
    }
    for (const column of WORKSHEET_COLUMNS) {
      if (!COLUMN_PATTERN.test(form.mapping[column.key] as string)) {
        errors.push(
          `“${column.label}” column must be a column letter (A–ZZ).`,
        );
      }
    }
    for (const key of CATEGORY_KEYS) {
      if (!COLUMN_PATTERN.test(form.mapping.categories[key])) {
        errors.push(
          `“${categoryNames[key]}” column must be a column letter (A–ZZ).`,
        );
      }
    }
    return errors;
  }

  async function handleToggleAutoSync(checked: boolean) {
    setForm((prev) => ({
      ...prev,
      mapping: { ...prev.mapping, autoSyncTasks: checked },
    }));
    // Without a saved sync config there is nothing to PATCH; Save will persist it.
    if (!hasSyncConfig) return;
    setTogglingAutoSync(true);
    try {
      await apiFetch("/api/sync-config", {
        method: "PATCH",
        body: JSON.stringify({ autoSyncTasks: checked }),
      });
      toast.success(checked ? "Auto-sync enabled" : "Auto-sync disabled");
    } catch (err) {
      setForm((prev) => ({
        ...prev,
        mapping: { ...prev.mapping, autoSyncTasks: !checked },
      }));
      toast.error(err instanceof Error ? err.message : "Could not update sync setting");
    } finally {
      setTogglingAutoSync(false);
    }
  }

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    const errors = validate();
    setFieldErrors(errors);
    if (errors.length > 0) {
      toast.error("Fix the highlighted fields before saving.");
      return;
    }
    setSaving(true);
    try {
      await apiFetch("/api/sync-config", {
        method: "PUT",
        body: JSON.stringify({
          spreadsheetId: form.spreadsheetId.trim().length > 0
            ? form.spreadsheetId.trim()
            : undefined,
          worksheetName: form.worksheetName.trim(),
          sheetGid: form.sheetGid.trim().length > 0
            ? form.sheetGid.trim()
            : undefined,
          timezone: form.timezone.trim(),
          mapping: {
            dateColumn: form.mapping.dateColumn,
            clockInColumn: form.mapping.clockInColumn,
            breakStartColumn: form.mapping.breakStartColumn,
            breakEndColumn: form.mapping.breakEndColumn,
            clockOutColumn: form.mapping.clockOutColumn,
            dailyTotalColumn: form.mapping.dailyTotalColumn,
            workTotalColumn: form.mapping.workTotalColumn,
            categories: {
              website_management: form.mapping.categories.website_management,
              cyber_security: form.mapping.categories.cyber_security,
              technology_innovation:
                form.mapping.categories.technology_innovation,
              infrastructure_management:
                form.mapping.categories.infrastructure_management,
              research: form.mapping.categories.research,
              meeting: form.mapping.categories.meeting,
              training: form.mapping.categories.training,
              other_tasks: form.mapping.categories.other_tasks,
            },
            ...(form.mapping.categoryNotes ? { categoryNotes: form.mapping.categoryNotes } : {}),
            autoSyncOnClockIn: form.mapping.autoSyncOnClockIn ?? true,
            autoSyncOnClockOut: form.mapping.autoSyncOnClockOut ?? true,
            autoSyncTasks: form.mapping.autoSyncTasks ?? true,
            ...(headerRow !== undefined ? { headerRow } : {}),
          },
        }),
      });
      setHasSyncConfig(true);
      toast.success("Settings saved.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="w-full">
      <header>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          Settings
        </h1>
      </header>

      <Separator className="my-6" />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        <div className="lg:col-span-8 flex flex-col gap-6">
          <Card className="shadow-xs border-border/80">
          <CardHeader>
            <CardTitle>Google Sheets &amp; file sync</CardTitle>
            <CardDescription>
              Where the reviewed day lands. Column letters map TETRA fields to
              worksheet cells — verify them against the actual workbook before
              the first sync. Google needs a spreadsheet ID; the file path
              (upload .xlsx/.csv on the Reports page) uses only the worksheet
              name and these mappings.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="grid gap-3" aria-label="Loading settings" data-loading="true">
                {[0, 1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="h-11 animate-pulse rounded-lg bg-muted"
                    aria-hidden
                  />
                ))}
              </div>
            ) : (
              <form onSubmit={handleSave} className="grid gap-6">
                {loadError && (
                  <p role="alert" className="text-sm text-destructive">
                    {loadError} — defaults shown below.
                  </p>
                )}
                <div className="grid gap-4 sm:grid-cols-3">
                  <div className="grid gap-2">
                    <Label htmlFor="spreadsheet-id">
                      Spreadsheet ID{" "}
                      <span className="font-normal text-muted-foreground">
                        (Google sync)
                      </span>
                    </Label>
                    <Input
                      id="spreadsheet-id"
                      className="h-11 font-mono text-xs"
                      value={form.spreadsheetId}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          spreadsheetId: e.target.value,
                        }))
                      }
                      placeholder="e.g. 1BxiMVs0X..."
                      autoComplete="off"
                      spellCheck={false}
                      data-testid="settings-spreadsheet-id"
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="worksheet-name">Worksheet (tab name)</Label>
                    <Input
                      id="worksheet-name"
                      className="h-11"
                      value={form.worksheetName}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          worksheetName: e.target.value,
                        }))
                      }
                      placeholder="e.g. Sheet1"
                      autoComplete="off"
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Used for API ranges (e.g. &apos;Sheet1&apos;!A1:FS100)
                    </p>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="sheet-gid">
                      Sheet GID{" "}
                      <span className="font-normal text-muted-foreground">
                        (tab ID)
                      </span>
                    </Label>
                    <Input
                      id="sheet-gid"
                      className="h-11 font-mono text-xs"
                      value={form.sheetGid}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          sheetGid: e.target.value,
                        }))
                      }
                      placeholder="e.g. 0"
                      autoComplete="off"
                    />
                    <p className="text-[11px] text-muted-foreground">
                      From URL #gid=... for direct links
                    </p>
                  </div>
                </div>

                {form.spreadsheetId ? (
                  <div className="flex items-center gap-2 pt-1 text-xs">
                    <a
                      href={`https://docs.google.com/spreadsheets/d/${form.spreadsheetId}/edit${form.sheetGid ? `?gid=${form.sheetGid}#gid=${form.sheetGid}` : ""}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                    >
                      Open configured Google Sheet ↗
                    </a>
                  </div>
                ) : null}

                <fieldset className="grid gap-3">
                  <legend className="text-sm font-medium">
                    Worksheet columns
                  </legend>
                  <div className="flex flex-wrap gap-x-6 gap-y-3">
                    {WORKSHEET_COLUMNS.map((column) => (
                      <ColumnInput
                        key={column.key}
                        id={`col-${column.key}`}
                        label={column.label}
                        value={form.mapping[column.key] as string}
                        onChange={(value) => setColumn(column.key, value)}
                        invalid={
                          !COLUMN_PATTERN.test(
                            form.mapping[column.key] as string,
                          )
                        }
                      />
                    ))}
                  </div>
                </fieldset>

                <fieldset className="grid gap-3">
                  <legend className="text-sm font-medium">
                    Category columns
                  </legend>
                  <div className="flex flex-wrap gap-x-6 gap-y-3">
                    {CATEGORY_KEYS.map((key) => (
                      <ColumnInput
                        key={key}
                        id={`cat-${key}`}
                        label={categoryNames[key]}
                        value={form.mapping.categories[key]}
                        onChange={(value) => setCategoryColumn(key, value)}
                        invalid={
                          !COLUMN_PATTERN.test(form.mapping.categories[key])
                        }
                      />
                    ))}
                  </div>
                </fieldset>

                <fieldset className="grid gap-3 pt-1 border-t border-border/60">
                  <legend className="text-sm font-medium">
                    Auto-sync preferences
                  </legend>
                  <p className="text-xs text-muted-foreground">
                    Automatically write shifts and tasks directly to the official Google Sheet without requiring manual submission.
                  </p>
                  <div className="grid gap-3 pt-1 sm:grid-cols-3">
                    <label className="flex items-start gap-2.5 rounded-lg border border-border/70 p-3 hover:bg-muted/30 cursor-pointer transition-colors">
                      <input
                        type="checkbox"
                        className="size-4 mt-0.5 rounded border-border text-primary focus:ring-primary/40 cursor-pointer"
                        checked={form.mapping.autoSyncOnClockIn ?? true}
                        onChange={(e) =>
                          setForm((prev) => ({
                            ...prev,
                            mapping: {
                              ...prev.mapping,
                              autoSyncOnClockIn: e.target.checked,
                            },
                          }))
                        }
                      />
                      <div className="space-y-0.5">
                        <span className="text-xs font-semibold text-foreground block">
                          Clock-in Auto-sync
                        </span>
                        <span className="text-[11px] text-muted-foreground block leading-tight">
                          Sync clock-in time to Google Sheet as soon as work starts.
                        </span>
                      </div>
                    </label>

                    <label className="flex items-start gap-2.5 rounded-lg border border-border/70 p-3 hover:bg-muted/30 cursor-pointer transition-colors">
                      <input
                        type="checkbox"
                        className="size-4 mt-0.5 rounded border-border text-primary focus:ring-primary/40 cursor-pointer"
                        checked={form.mapping.autoSyncOnClockOut ?? true}
                        onChange={(e) =>
                          setForm((prev) => ({
                            ...prev,
                            mapping: {
                              ...prev.mapping,
                              autoSyncOnClockOut: e.target.checked,
                            },
                          }))
                        }
                      />
                      <div className="space-y-0.5">
                        <span className="text-xs font-semibold text-foreground block">
                          Clock-out Auto-sync
                        </span>
                        <span className="text-[11px] text-muted-foreground block leading-tight">
                          Sync full day report (times &amp; totals) when work day ends.
                        </span>
                      </div>
                    </label>

                    <div className="flex items-start gap-2.5 rounded-lg border border-border/70 p-3">
                      <Switch
                        id="auto-sync-tasks-switch"
                        className="mt-0.5"
                        checked={form.mapping.autoSyncTasks ?? true}
                        disabled={togglingAutoSync}
                        onCheckedChange={handleToggleAutoSync}
                        data-testid="auto-sync-switch"
                      />
                      <div className="space-y-0.5">
                        <Label
                          htmlFor="auto-sync-tasks-switch"
                          className="text-xs font-semibold text-foreground block cursor-pointer"
                        >
                          Timeline Auto-sync
                        </Label>
                        <span className="text-[11px] text-muted-foreground block leading-tight">
                          Controls background sync of the day to Google Sheet when you
                          add, edit or delete Timeline entries. Applies immediately.
                        </span>
                      </div>
                    </div>
                  </div>
                </fieldset>

                <div className="grid gap-2 sm:max-w-xs">
                  <Label htmlFor="timezone">Timezone</Label>
                  <Input
                    id="timezone"
                    className="h-11"
                    value={form.timezone}
                    onChange={(e) =>
                      setForm((prev) => ({
                        ...prev,
                        timezone: e.target.value,
                      }))
                    }
                    placeholder="Asia/Jakarta"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <p className="text-xs text-muted-foreground">
                    IANA name, e.g. Asia/Jakarta.
                  </p>
                </div>

                {fieldErrors.length > 0 && (
                  <ul role="alert" className="grid gap-1 text-sm text-destructive">
                    {fieldErrors.map((message) => (
                      <li key={message}>{message}</li>
                    ))}
                  </ul>
                )}

                {testResult && (
                  <div
                    className={`rounded-lg border p-4 text-xs ${
                      testResult.ok
                        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-950 dark:text-emerald-100"
                        : "border-destructive/30 bg-destructive/10 text-destructive dark:text-red-300"
                    }`}
                  >
                    <div className="flex items-start gap-2.5">
                      {testResult.ok ? (
                        <CheckCircle2 className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400 mt-0.5" />
                      ) : (
                        <AlertCircle className="size-4 shrink-0 text-destructive mt-0.5" />
                      )}
                      <div className="flex-1 space-y-1">
                        <p className="font-semibold text-sm">
                          {testResult.ok
                            ? `Connected: ${testResult.spreadsheetTitle}`
                            : "Could not read online spreadsheet"}
                        </p>
                        {testResult.ok ? (
                          <div className="space-y-1.5 pt-1">
                            <p>
                              Worksheet tab:{" "}
                              <span className="font-semibold font-mono">
                                {testResult.targetSheetName}
                              </span>
                              {testResult.targetSheetGid ? (
                                <span className="text-muted-foreground ml-1">
                                  (GID: {testResult.targetSheetGid})
                                </span>
                              ) : null}
                            </p>
                            <p className="text-muted-foreground">
                              Available tabs:{" "}
                              {testResult.sheets.map((s) => s.title).join(", ")}
                            </p>
                            {testResult.sampleValues &&
                            testResult.sampleValues.length > 0 ? (
                              <div className="mt-2 pt-2 border-t border-emerald-500/20">
                                <p className="font-medium mb-1">
                                  Sample online data ({testResult.sampleRange}):
                                </p>
                                <div className="max-h-36 overflow-auto rounded bg-background/80 p-2 font-mono text-[11px] border border-border/50 text-foreground">
                                  <table className="w-full text-left border-collapse">
                                    <tbody>
                                      {testResult.sampleValues
                                        .slice(0, 4)
                                        .map((row, rIdx) => (
                                          <tr
                                            key={rIdx}
                                            className="border-b border-border/40 last:border-b-0"
                                          >
                                            <td className="pr-2 py-0.5 text-muted-foreground select-none">
                                              R{rIdx + 1}
                                            </td>
                                            {row.slice(0, 8).map((val, cIdx) => (
                                              <td
                                                key={cIdx}
                                                className="px-2 py-0.5 truncate max-w-[120px]"
                                              >
                                                {String(val || "—")}
                                              </td>
                                            ))}
                                          </tr>
                                        ))}
                                    </tbody>
                                  </table>
                                </div>
                              </div>
                            ) : null}
                          </div>
                        ) : (
                          <div className="space-y-1 pt-1">
                            <p className="font-mono text-[11px] break-all">
                              {testResult.error}
                            </p>
                            {testResult.authMethod === "none" && (
                              <p className="text-muted-foreground pt-1">
                                Tip: Sign in with Google (or provide Google Service
                                Account credentials in .env.local) to authorize access.
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    type="submit"
                    className="h-11 px-5"
                    disabled={saving}
                    data-testid="settings-save"
                  >
                    {saving ? "Saving…" : "Save"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11 gap-2"
                    onClick={handleTestConnection}
                    disabled={testingConnection || saving}
                    data-testid="settings-test-connection"
                  >
                    {testingConnection ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <RefreshCw className="size-4" />
                    )}
                    Test Connection &amp; Read Online
                  </Button>
                </div>
              </form>
            )}
          </CardContent>
        </Card>

        <CalendarSettingsCard />
      </div>

      <div className="lg:col-span-4 flex flex-col gap-6">
        <Card className="shadow-xs border-border/80">
          <CardHeader>
            <CardTitle>Account</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="flex items-center gap-3.5 pb-2 border-b border-border/60">
              <div className="flex size-12 shrink-0 items-center justify-center rounded-full overflow-hidden border border-border/80 text-sm font-semibold text-primary bg-primary/10">
                {image ? (
                  <Image
                    src={image}
                    alt={name || email || "User"}
                    width={48}
                    height={48}
                    unoptimized
                    referrerPolicy="no-referrer"
                    className="size-full object-cover"
                  />
                ) : (
                  <span>
                    {(name || email || "U").slice(0, 2).toUpperCase()}
                  </span>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-sm text-foreground truncate">
                  {name || "User"}
                </p>
                <p className="text-xs text-muted-foreground truncate">{email ?? "Not signed in"}</p>
                <div className="mt-1 flex items-center gap-1.5">
                  {hasGoogleAuth ? (
                    <span className="inline-flex items-center gap-1 text-[10px] bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded-full font-medium">
                      Google Account Connected
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-[10px] bg-muted text-muted-foreground px-2 py-0.5 rounded-full font-medium">
                      Development Account
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="grid gap-2 text-xs">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-muted-foreground">Email</p>
                <p className="font-medium text-foreground">{email ?? "Not signed in"}</p>
              </div>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-muted-foreground">Timezone</p>
                <p className="font-medium text-foreground">{userTimezone}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <NotificationsSettingsCard />

        <Card className="shadow-xs border-border/80">
          <CardHeader>
            <CardTitle>Agent access</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <p className="text-xs text-muted-foreground">
              Manage API tokens and approve deletes requested by an agent.
            </p>
            <Button asChild variant="outline" size="sm">
              <Link href="/settings/agent">Open agent access</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  </div>
  );
}
