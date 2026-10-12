"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, Check, Copy, KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { ApiError, apiFetch } from "@/components/timeline/api";
import { useNotifications } from "@/features/notifications/store";
import type { AgentActionDTO } from "@/features/agent-api/actions";
import {
  describeImpact,
  needsSyncDays,
  needsSyncMessage,
  summarizeResult,
} from "./agent-access-format";

const SCOPES = ["read", "write", "delete"] as const;
type Scope = (typeof SCOPES)[number];

interface TokenRow {
  id: string;
  name: string;
  prefix: string;
  scopes: Scope[];
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

interface CreatedToken {
  token: string;
}

function fmt(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong";
}

export function AgentAccessView() {
  const [bypass, setBypass] = useState(false);
  const [devLogin, setDevLogin] = useState(false);

  useEffect(() => {
    apiFetch<{ devLoginEnabled?: boolean }>("/api/auth-config")
      .then((c) => setDevLogin(c.devLoginEnabled === true))
      .catch(() => undefined);
  }, []);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-4 md:p-6">
      <div className="flex items-center gap-3">
        <Button asChild variant="ghost" size="icon" aria-label="Back to settings">
          <Link href="/settings">
            <ArrowLeft />
          </Link>
        </Button>
        <h1 className="text-xl font-semibold">Agent access</h1>
      </div>

      {devLogin && (
        <div
          role="alert"
          data-testid="agent-dev-login-banner"
          className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          Dev login is enabled (ALLOW_DEV_LOGIN): anyone who can reach this app can sign in as any
          email and manage agent tokens
        </div>
      )}

      {bypass ? (
        <div
          role="alert"
          data-testid="agent-bypass-banner"
          className="rounded-lg border border-border bg-muted p-3 text-sm"
        >
          Agent access is disabled while DISABLE_AUTH is on
        </div>
      ) : null}

      <TokensCard onBypass={() => setBypass(true)} disabled={bypass} />
      {!bypass && <ApprovalsCard />}
      {!bypass && <ActivityCard />}
    </div>
  );
}

// ---------------------------------------------------------------------------

function TokensCard({ onBypass, disabled }: { onBypass: () => void; disabled: boolean }) {
  const [tokens, setTokens] = useState<TokenRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Scope[]>(["read"]);
  const [days, setDays] = useState("");
  const [busy, setBusy] = useState(false);
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<{ tokens: TokenRow[] }>("/api/api-tokens");
      setTokens(data.tokens);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403 && err.code === "auth_bypass") {
        onBypass();
        setTokens([]);
      } else {
        setError(errText(err));
      }
    }
  }, [onBypass]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const reset = () => {
    setName("");
    setScopes(["read"]);
    setDays("");
    setPlaintext(null);
    setCopied(false);
  };

  const toggleScope = (scope: Scope, checked: boolean) =>
    setScopes((prev) => (checked ? [...new Set([...prev, scope])] : prev.filter((s) => s !== scope)));

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const body: { name: string; scopes: Scope[]; expiresInDays?: number } = {
        name: name.trim(),
        scopes,
      };
      if (days.trim()) body.expiresInDays = Number(days);
      const created = await apiFetch<CreatedToken>("/api/api-tokens", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setPlaintext(created.token);
      await load();
    } catch (err) {
      toast.error(errText(err));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!plaintext) return;
    try {
      await navigator.clipboard.writeText(plaintext);
      setCopied(true);
    } catch {
      toast.error("Could not copy. Select the token and copy it manually.");
    }
  };

  const revoke = async (t: TokenRow) => {
    if (
      !confirm(
        `Revoke "${t.name}"? Any pending approvals from this token will expire and the agent loses access immediately.`,
      )
    ) {
      return;
    }
    try {
      await apiFetch(`/api/api-tokens/${t.id}`, { method: "DELETE" });
      toast.success("Token revoked");
      await load();
    } catch (err) {
      toast.error(errText(err));
    }
  };

  return (
    <Card className="shadow-xs border-border/80">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle>API tokens</CardTitle>
            <CardDescription>Bearer tokens that let an agent such as OpenClaw call Tetra.</CardDescription>
          </div>
          <Button
            size="sm"
            data-testid="agent-token-create"
            disabled={disabled}
            onClick={() => {
              reset();
              setOpen(true);
            }}
          >
            <KeyRound /> New token
          </Button>
        </div>
      </CardHeader>
      <CardContent className="grid gap-2">
        {error && <p className="text-sm text-destructive">{error}</p>}
        {tokens === null && !error && <Loader2 className="size-4 animate-spin" aria-label="Loading tokens" />}
        {tokens?.length === 0 && !disabled && <p className="text-sm text-muted-foreground">No tokens yet.</p>}
        {tokens?.map((t) => (
          <div key={t.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm">
            <div className="min-w-0">
              <p className="font-medium">
                {t.name} <span className="font-mono text-xs text-muted-foreground">{t.prefix}…</span>
              </p>
              <p className="text-xs text-muted-foreground">
                {t.scopes.join(", ")} · created {fmt(t.createdAt)} · last used {fmt(t.lastUsedAt)}
                {t.expiresAt ? ` · expires ${fmt(t.expiresAt)}` : ""}
              </p>
            </div>
            {t.revokedAt ? (
              <Badge variant="secondary">Revoked</Badge>
            ) : (
              <Button size="sm" variant="destructive" onClick={() => void revoke(t)}>
                Revoke
              </Button>
            )}
          </div>
        ))}
      </CardContent>

      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{plaintext ? "Copy your token" : "New API token"}</DialogTitle>
            <DialogDescription>
              {plaintext
                ? "This is the only time it is shown. Store it as TETRA_API_TOKEN in the agent's environment."
                : "Choose what the agent may do. Deletes always need your approval here."}
            </DialogDescription>
          </DialogHeader>
          {plaintext ? (
            <div className="grid gap-3">
              <code
                data-testid="agent-token-plaintext"
                className="break-all rounded-md border bg-muted p-2 text-xs"
              >
                {plaintext}
              </code>
              <Button variant="outline" onClick={() => void copy()}>
                {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy"}
              </Button>
              <DialogFooter>
                <Button onClick={() => setOpen(false)}>Done</Button>
              </DialogFooter>
            </div>
          ) : (
            <form onSubmit={create} className="grid gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor="agent-token-name">Name</Label>
                <Input
                  id="agent-token-name"
                  data-testid="agent-token-name"
                  value={name}
                  maxLength={80}
                  required
                  onChange={(e) => setName(e.target.value)}
                  placeholder="OpenClaw"
                />
              </div>
              <fieldset className="grid gap-1.5">
                <legend className="text-sm font-medium">Scopes</legend>
                {SCOPES.map((s) => (
                  <label key={s} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      data-testid={`agent-token-scope-${s}`}
                      checked={scopes.includes(s)}
                      onChange={(e) => toggleScope(s, e.target.checked)}
                    />
                    {s}
                  </label>
                ))}
              </fieldset>
              <div className="grid gap-1.5">
                <Label htmlFor="agent-token-days">Expires in days (optional)</Label>
                <Input
                  id="agent-token-days"
                  type="number"
                  min={1}
                  max={365}
                  value={days}
                  onChange={(e) => setDays(e.target.value)}
                />
              </div>
              <DialogFooter>
                <Button type="submit" disabled={busy || !name.trim() || scopes.length === 0}>
                  {busy && <Loader2 className="animate-spin" />} Create token
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function ApprovalsCard() {
  const { refreshAlerts } = useNotifications();
  const [actions, setActions] = useState<AgentActionDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<{ actions: AgentActionDTO[] }>("/api/agent-actions?status=pending");
      setActions(data.actions);
      setError(null);
    } catch (err) {
      setError(errText(err));
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const approve = async (a: AgentActionDTO) => {
    setWorking(a.id);
    try {
      const { action } = await apiFetch<{ action: AgentActionDTO }>(
        `/api/agent-actions/${a.id}/approve`,
        {
          method: "POST",
          body: JSON.stringify({ expectedFingerprint: a.live?.fingerprint ?? null }),
        },
      );
      if (action.status === "failed") {
        const r = action.result ?? {};
        toast.error(typeof r.error === "string" ? r.error : "The delete failed");
      } else {
        const msg = needsSyncMessage(needsSyncDays(action.result));
        toast.success("Deleted", msg ? { description: msg } : undefined);
      }
    } catch (err) {
      toast.error(errText(err));
    } finally {
      setWorking(null);
      await load();
      await refreshAlerts();
    }
  };

  const reject = async (a: AgentActionDTO) => {
    setWorking(a.id);
    try {
      await apiFetch(`/api/agent-actions/${a.id}/reject`, { method: "POST", body: "{}" });
      toast.success("Rejected");
    } catch (err) {
      toast.error(errText(err));
    } finally {
      setWorking(null);
      await load();
      await refreshAlerts();
    }
  };

  return (
    <Card className="shadow-xs border-border/80">
      <CardHeader>
        <CardTitle>Pending approvals</CardTitle>
        <CardDescription>Deletes requested by an agent run only after you approve them.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {error && <p className="text-sm text-destructive">{error}</p>}
        {actions === null && !error && <Loader2 className="size-4 animate-spin" aria-label="Loading approvals" />}
        {actions?.length === 0 && <p className="text-sm text-muted-foreground">Nothing waiting for approval.</p>}
        {actions?.map((a) => {
          const impact = describeImpact(a.targetType, a.live?.impact ?? a.summary.impact);
          return (
            <div key={a.id} className="grid gap-2 rounded-lg border p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-medium">{a.live?.label ?? a.summary.label ?? "(unknown target)"}</p>
                <Badge variant="outline">{a.kind}</Badge>
                {a.tokenName && <span className="text-xs text-muted-foreground">via {a.tokenName}</span>}
              </div>
              {impact.lines.length > 0 && <p className="text-muted-foreground">{impact.lines.join("; ")}</p>}
              {impact.warnings.map((w) => (
                <p key={w} className="text-amber-700 dark:text-amber-400">{w}</p>
              ))}
              {a.reason && (
                <p>
                  <span className="text-xs text-muted-foreground">agent says: </span>
                  {a.reason}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                requested {fmt(a.createdAt)} · expires {fmt(a.expiresAt)}
              </p>
              {a.stale && (
                <p
                  data-testid={`agent-action-stale-${a.id}`}
                  className="flex items-center gap-1.5 text-amber-700 dark:text-amber-400"
                >
                  <AlertTriangle className="size-4" /> Changed since request
                </p>
              )}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="destructive"
                  data-testid={`agent-action-approve-${a.id}`}
                  disabled={working === a.id}
                  onClick={() => void approve(a)}
                >
                  {working === a.id && <Loader2 className="animate-spin" />} Approve
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid={`agent-action-reject-${a.id}`}
                  disabled={working === a.id}
                  onClick={() => void reject(a)}
                >
                  Reject
                </Button>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function ActivityCard() {
  const [actions, setActions] = useState<AgentActionDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ actions: AgentActionDTO[] }>("/api/agent-actions?limit=50")
      .then((d) => setActions(d.actions))
      .catch((err) => setError(errText(err)));
  }, []);

  return (
    <Card className="shadow-xs border-border/80">
      <CardHeader>
        <CardTitle>Recent agent activity</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2">
        {error && <p className="text-sm text-destructive">{error}</p>}
        {actions === null && !error && <Loader2 className="size-4 animate-spin" aria-label="Loading activity" />}
        {actions?.length === 0 && <p className="text-sm text-muted-foreground">No agent activity yet.</p>}
        {actions?.map((a) => (
          <div key={a.id} className="flex flex-wrap items-center justify-between gap-2 border-b py-2 text-sm last:border-0">
            <div className="min-w-0">
              <p className="truncate">{a.summary.label ?? a.kind}</p>
              <p className="text-xs text-muted-foreground">
                {a.kind}
                {a.tokenName ? ` · ${a.tokenName}` : ""} · {fmt(a.createdAt)}
                {summarizeResult(a) ? ` · ${summarizeResult(a)}` : ""}
              </p>
            </div>
            <Badge variant={a.status === "failed" ? "destructive" : "secondary"}>{a.status}</Badge>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
