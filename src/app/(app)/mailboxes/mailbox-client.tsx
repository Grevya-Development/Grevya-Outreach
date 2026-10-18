"use client";

import { AlertTriangle, Check, ChevronDown, Eye, EyeOff, MoreHorizontal, Pause, Pencil, Play, Plus, RotateCcw, Send, ShieldCheck, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  checkMailboxDomain, deleteMailbox, detectProvider, restartWarmup, saveMailbox, sendTestEmail, setMailboxStatus, testMailbox,
  type ConnectionTest, type MailboxInput,
} from "@/app/actions/mailboxes";
import { ActionButton, Dialog, Spinner, Switch, useAction } from "@/components/client";
import { Badge, Button, Card, Field, Input, Progress, Select, StatusBadge, Textarea, buttonClass, cx, timeAgo } from "@/components/ui";
import { PROVIDERS, type CheckResult, type ProviderKey } from "@/lib/providers";
import type { HealthCheck } from "@/lib/domain-health";
import { inSendingWindow, MAILBOX_HARD_CAP, windowCapacity } from "@/lib/schedule";
import type { PublicMailbox } from "@/lib/types";

const DAYS = ["S", "M", "T", "W", "T", "F", "S"];
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;
const TIMEZONES = ["Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Europe/London", "Europe/Berlin", "America/New_York", "America/Chicago", "America/Los_Angeles", "Australia/Sydney", "UTC"];

function blank(): MailboxInput {
  return {
    email: "", from_name: "", ...PROVIDERS.godaddy, username: "", password: "",
    daily_limit: MAILBOX_HARD_CAP, warmup_enabled: true, warmup_start: 20, warmup_increment: 10,
    min_delay_sec: 60, max_delay_sec: 180, timezone: "Asia/Kolkata", window_start: 9, window_end: 18,
    send_days: [1, 2, 3, 4, 5], signature: "", save_to_sent: true,
  };
}

function fromMailbox(m: PublicMailbox): MailboxInput {
  return {
    id: m.id, email: m.email, from_name: m.from_name, smtp_host: m.smtp_host, smtp_port: m.smtp_port, smtp_secure: m.smtp_secure,
    imap_host: m.imap_host ?? "", imap_port: m.imap_port, username: m.username, password: "", daily_limit: m.daily_limit,
    warmup_enabled: m.warmup_enabled, warmup_start: m.warmup_start, warmup_increment: m.warmup_increment,
    min_delay_sec: m.min_delay_sec, max_delay_sec: m.max_delay_sec, timezone: m.timezone, window_start: m.window_start,
    window_end: m.window_end, send_days: m.send_days, signature: m.signature, save_to_sent: m.save_to_sent,
  };
}

function presetOf(f: Pick<MailboxInput, "smtp_host">): ProviderKey {
  return (Object.keys(PROVIDERS) as ProviderKey[]).find((k) => k !== "custom" && PROVIDERS[k].smtp_host === f.smtp_host) ?? "custom";
}

export function AddMailboxButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}><Plus size={15} />Add mailbox</Button>
      {open && <MailboxDialog initial={blank()} onClose={() => setOpen(false)} />}
    </>
  );
}

function MailboxDialog({ initial, onClose }: { initial: MailboxInput; onClose: () => void }) {
  const isEdit = Boolean(initial.id);
  const [f, setF] = useState(initial);
  const [showPw, setShowPw] = useState(false);
  const [detected, setDetected] = useState<ProviderKey | null>(null);
  const [showServer, setShowServer] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [result, setResult] = useState<ConnectionTest | null>(null);
  const [busy, start] = useTransition();
  const [phase, setPhase] = useState<"idle" | "testing" | "saving">("idle");
  const set = <K extends keyof MailboxInput>(k: K, v: MailboxInput[K]) => { setF((p) => ({ ...p, [k]: v })); setResult(null); };
  const preset = presetOf(f);
  const resultRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (result || phase === "testing") resultRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [result, phase]);

  // Pick the provider automatically from the domain's MX records.
  useEffect(() => {
    if (isEdit) return;
    const domain = f.email.split("@")[1];
    if (!domain || !domain.includes(".")) return;
    const t = setTimeout(async () => {
      const p = await detectProvider(f.email).catch(() => null);
      setDetected(p);
      if (p) {
        const cfg = PROVIDERS[p];
        setF((prev) => ({ ...prev, smtp_host: cfg.smtp_host, smtp_port: cfg.smtp_port, smtp_secure: cfg.smtp_secure, imap_host: cfg.imap_host, imap_port: cfg.imap_port }));
      } else setShowServer(true);
    }, 500);
    return () => clearTimeout(t);
  }, [f.email, isEdit]);

  const test = (thenSave: boolean, force = false, override: Partial<MailboxInput> = {}) => start(async () => {
    try {
      let r = result;
      if (!force) {
        setPhase("testing");
        setResult(null);
        r = await testMailbox(f, PROVIDERS[preset].label);
        setResult(r);
        if (!r.smtp.ok) setShowServer(true);
      }
      if (thenSave && (force || r?.smtp.ok)) {
        setPhase("saving");
        const s = await saveMailbox({ ...f, ...override });
        if (!s.ok) { toast.error(s.error); return; }
        toast.success(isEdit ? "Mailbox updated" : `${f.email} connected`);
        onClose();
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setPhase("idle");
    }
  });

  const canSubmit = f.email.includes("@") && (isEdit || f.password);
  const smtpOkImapBad = result?.smtp.ok && result.imap && !result.imap.ok;

  return (
    <Dialog
      open
      onClose={onClose}
      title={isEdit ? `Edit ${initial.email}` : "Connect a mailbox"}
      description={isEdit ? "Leave the password blank to keep the current one." : "We'll check the login before saving. Nothing is sent."}
      footer={
        <>
          {isEdit && <Button type="button" onClick={() => test(false)} disabled={busy}>{phase === "testing" ? <Spinner /> : null}Test connection</Button>}
          {smtpOkImapBad && <Button type="button" onClick={() => test(true, true, { imap_host: "" })} disabled={busy}>Save without reply detection</Button>}
          <Button type="button" variant="primary" disabled={busy || !canSubmit} onClick={() => test(true, isEdit && !f.password && !result)}>
            {busy && <Spinner />}
            {phase === "testing" ? "Checking login…" : phase === "saving" ? "Saving…" : isEdit ? "Save" : "Connect & save"}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4">
        <Field label="Email address">
          <Input value={f.email} type="email" autoFocus={!isEdit} placeholder="info@grevya.com" onChange={(e) => set("email", e.target.value.trim())} disabled={isEdit} />
        </Field>
        <Field label="Email password" hint={preset === "godaddy" ? "The password you use to log in to this inbox at email.secureserver.net — not your GoDaddy account password." : preset === "google" ? "Use a Google App Password." : undefined}>
          <div className="relative">
            <Input type={showPw ? "text" : "password"} value={f.password} autoComplete="new-password" placeholder={isEdit ? "••••••••  (unchanged)" : ""} onChange={(e) => set("password", e.target.value)} className="pr-10" />
            <button type="button" onClick={() => setShowPw((v) => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-faint hover:text-ink" aria-label={showPw ? "Hide password" : "Show password"}>
              {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
        </Field>
        <Field label="Your name (shown to recipients)" hint="Fills {{sender_name}} in emails">
          <Input value={f.from_name} placeholder="Kavin from Grevya" onChange={(e) => set("from_name", e.target.value)} />
        </Field>

        {/* Provider */}
        <div className="rounded-lg border border-line">
          <button type="button" onClick={() => setShowServer((v) => !v)} className="w-full flex items-center gap-2 px-3 h-10 text-[13px]">
            <span className="text-muted hidden sm:inline">Provider</span>
            <span className="font-medium truncate min-w-0">{PROVIDERS[preset].label}</span>
            {detected && detected === preset && <Badge tone="good" className="shrink-0">detected</Badge>}
            <span className="ml-auto shrink-0 text-muted inline-flex items-center gap-1"><span className="hidden sm:inline">{showServer ? "Hide" : "Change"}</span><ChevronDown size={14} className={cx("transition-transform", showServer && "rotate-180")} /></span>
          </button>
          {showServer && (
            <div className="grid grid-cols-1 gap-3 px-3 pb-3 fade-in">
              <Select value={preset} onChange={(e) => {
                const p = PROVIDERS[e.target.value as ProviderKey];
                setF((prev) => ({ ...prev, smtp_host: p.smtp_host, smtp_port: p.smtp_port, smtp_secure: p.smtp_secure, imap_host: p.imap_host, imap_port: p.imap_port }));
                setResult(null);
              }}>
                {(Object.keys(PROVIDERS) as ProviderKey[]).map((k) => <option key={k} value={k}>{PROVIDERS[k].label}</option>)}
              </Select>
              <div className="grid grid-cols-[minmax(0,1fr)_80px] gap-2">
                <Field label="SMTP server (sending)"><Input value={f.smtp_host} onChange={(e) => set("smtp_host", e.target.value.trim())} /></Field>
                <Field label="Port"><Input type="number" value={f.smtp_port} onChange={(e) => { const p = Number(e.target.value); setF((prev) => ({ ...prev, smtp_port: p, smtp_secure: p === 465 })); setResult(null); }} /></Field>
                <Field label="IMAP server (replies)"><Input value={f.imap_host} onChange={(e) => set("imap_host", e.target.value.trim())} /></Field>
                <Field label="Port"><Input type="number" value={f.imap_port} onChange={(e) => set("imap_port", Number(e.target.value))} /></Field>
              </div>
              <Field label="Login username" hint="Usually the full email address"><Input value={f.username} placeholder={f.email || "same as email"} onChange={(e) => set("username", e.target.value.trim())} /></Field>
            </div>
          )}
        </div>

        {/* Result */}
        <div ref={resultRef} className="empty:hidden grid grid-cols-1 gap-2">
        {phase === "testing" && (
          <div className="flex items-center gap-2 rounded-lg bg-panel-2 px-3 py-3 text-[13px] text-muted fade-in">
            <Spinner />Signing in to {f.smtp_host || "the server"}… this takes a few seconds.
          </div>
        )}
        {result && (
          <div className="grid grid-cols-1 gap-2 fade-in" aria-live="polite">
            <CheckRow label="Sending (SMTP)" r={result.smtp} />
            {result.imap ? <CheckRow label="Reply detection (IMAP)" r={result.imap} /> : <CheckRow label="Reply detection (IMAP)" r={{ ok: false, message: "No IMAP server set — replies and bounces won't be detected." }} />}
          </div>
        )}
        </div>

        {/* Schedule & limits */}
        <div className="rounded-lg border border-line">
          <button type="button" onClick={() => setShowSchedule((v) => !v)} className="w-full flex items-center gap-2 px-3 py-2.5 text-left text-[13px]">
            <div className="min-w-0 flex-1">
              <div className="font-medium">Limits & schedule</div>
              <div className="text-[12px] text-muted truncate">
                Up to {f.daily_limit}/day · {f.warmup_enabled ? `warm-up ${f.warmup_start} → +${f.warmup_increment}/day` : "no warm-up"} · {hh(f.window_start)}–{hh(f.window_end)} {DAY_NAMES.filter((_, i) => f.send_days.includes(i)).join(" ")}
              </div>
            </div>
            <ChevronDown size={14} className={cx("ml-auto shrink-0 text-muted transition-transform", showSchedule && "rotate-180")} />
          </button>
          {showSchedule && (
            <div className="grid grid-cols-1 gap-4 px-3 pb-3 fade-in">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Daily limit" hint={`Max ${MAILBOX_HARD_CAP}`}>
                  <Input type="number" min={1} max={MAILBOX_HARD_CAP} value={f.daily_limit} onChange={(e) => set("daily_limit", Math.min(MAILBOX_HARD_CAP, Number(e.target.value)))} />
                </Field>
                <Field label="Minimum gap (seconds)" hint="Emails are spread evenly across your sending hours with random gaps — never closer than this.">
                  <Input type="number" min={10} value={f.min_delay_sec} onChange={(e) => { const v = Number(e.target.value); setF((p) => ({ ...p, min_delay_sec: v, max_delay_sec: Math.max(v, p.max_delay_sec) })); }} />
                </Field>
              </div>
              <div className="rounded-lg bg-panel-2/60 p-3 grid grid-cols-1 gap-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[13px] font-medium">Warm-up</div>
                    <div className="text-[12px] text-muted">Start small, add a few more each day. Protects the mailbox from spam folders.</div>
                  </div>
                  <Switch checked={f.warmup_enabled} onChange={(v) => set("warmup_enabled", v)} label="Warm-up" />
                </div>
                {f.warmup_enabled && (
                  <>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <Field label="First day"><Input type="number" min={1} value={f.warmup_start} onChange={(e) => set("warmup_start", Number(e.target.value))} /></Field>
                      <Field label="Add each day"><Input type="number" min={0} value={f.warmup_increment} onChange={(e) => set("warmup_increment", Number(e.target.value))} /></Field>
                    </div>
                    <p className={cx("text-[12px]", f.warmup_start > 50 ? "text-warn" : "text-muted")}>
                      {f.warmup_start > 50
                        ? `Starting at ${f.warmup_start}/day is risky for a mailbox that hasn't sent cold email before. 20 is safer.`
                        : `Reaches ${f.daily_limit}/day after ${f.warmup_increment > 0 ? Math.max(0, Math.ceil((f.daily_limit - f.warmup_start) / f.warmup_increment)) : "∞"} days.`}
                    </p>
                  </>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Timezone">
                  <Select value={f.timezone} onChange={(e) => set("timezone", e.target.value)}>
                    {TIMEZONES.map((t) => <option key={t}>{t}</option>)}
                  </Select>
                </Field>
                <Field label="Sending hours">
                  <div className="flex items-center gap-1.5">
                    <Select value={f.window_start} onChange={(e) => set("window_start", Number(e.target.value))}>
                      {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hh(h)}</option>)}
                    </Select>
                    <Select value={f.window_end} onChange={(e) => set("window_end", Number(e.target.value))}>
                      {Array.from({ length: 24 }, (_, h) => h + 1).map((h) => <option key={h} value={h}>{hh(h)}</option>)}
                    </Select>
                  </div>
                </Field>
              </div>
              <Field label="Days">
                <div className="flex flex-wrap gap-1">
                  {DAYS.map((d, i) => {
                    const on = f.send_days.includes(i);
                    return (
                      <button key={i} type="button" aria-label={DAY_NAMES[i]} aria-pressed={on}
                        onClick={() => set("send_days", on ? f.send_days.filter((x) => x !== i) : [...f.send_days, i].sort())}
                        className={`size-9 rounded-lg text-[12.5px] font-medium border transition-colors ${on ? "bg-accent text-accent-ink border-accent" : "border-line text-muted hover:bg-panel-2"}`}>
                        {d}
                      </button>
                    );
                  })}
                </div>
              </Field>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[13px] font-medium">Save copies to the Sent folder</div>
                  <div className="text-[12px] text-muted">So every email the app sends also shows up in your normal email app, and conversations look complete.</div>
                </div>
                <Switch checked={f.save_to_sent ?? true} onChange={(v) => set("save_to_sent", v)} label="Save to Sent" />
              </div>
              <Field label="Signature" hint="Added under every email">
                <Textarea rows={3} value={f.signature} placeholder={"Kavin\nGrevya · grevya.com"} onChange={(e) => set("signature", e.target.value)} />
              </Field>
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function CheckRow({ label, r }: { label: string; r: CheckResult }) {
  return (
    <div className={cx("rounded-lg px-3 py-2.5 text-[13px] flex gap-2.5", r.ok ? "bg-good-soft" : "bg-bad-soft")}>
      <span className={cx("mt-0.5 shrink-0", r.ok ? "text-good" : "text-bad")}>{r.ok ? <Check size={15} /> : <X size={15} />}</span>
      <div className="min-w-0">
        <div className="font-medium text-ink">{label}</div>
        <div className="text-ink/80">{r.message}</div>
        {r.hint && <div className="text-muted mt-1">{r.hint}</div>}
        {r.detail && !r.ok && (
          <details className="mt-1 text-[12px] text-faint">
            <summary className="cursor-pointer select-none">Technical details</summary>
            <code className="block mt-1 break-all font-mono">{r.detail}</code>
          </details>
        )}
      </div>
    </div>
  );
}

export function MailboxCard({ mailbox: m, sentToday, limitToday }: { mailbox: PublicMailbox; sentToday: number; limitToday: number }) {
  const [editing, setEditing] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const open = inSendingWindow(m);
  const warming = m.warmup_enabled && limitToday < m.daily_limit;

  return (
    <Card className="p-4 fade-in">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium truncate">{m.email}</span>
            <StatusBadge status={m.status} />
            {warming && <Badge tone="info">warming up</Badge>}
            {m.status === "active" && <Badge tone={open ? "good" : "neutral"}>{open ? "in sending window" : "outside window"}</Badge>}
          </div>
          <div className="text-[12.5px] text-muted mt-1">
            {m.from_name || "No sender name"} · {m.smtp_host} · {hh(m.window_start)}–{hh(m.window_end)} {m.timezone}
            {m.imap_host ? ` · inbox checked ${timeAgo(m.imap_synced_at)}` : " · reply detection off (no IMAP)"}
          </div>
        </div>
        <div className="flex items-center gap-1.5 relative">
          {m.status === "active"
            ? <ActionButton size="sm" action={() => setMailboxStatus(m.id, "paused")}><Pause size={14} />Pause</ActionButton>
            : <ActionButton size="sm" variant="primary" action={() => setMailboxStatus(m.id, "active")}><Play size={14} />Resume</ActionButton>}
          <Button size="sm" onClick={() => setEditing(true)}><Pencil size={14} />Edit</Button>
          <Button size="sm" variant="ghost" className="w-8 px-0" aria-label="More" onClick={() => setMenu((v) => !v)}><MoreHorizontal size={16} /></Button>
          {menu && (
            <div className="absolute right-0 top-9 z-30 w-48 rounded-xl border border-line bg-panel shadow-xl p-1 fade-in" onMouseLeave={() => setMenu(false)}>
              <button className={buttonClass("ghost", "sm", "w-full justify-start")} onClick={() => { setMenu(false); setTestOpen(true); }}><Send size={14} />Send test email</button>
              <ActionButton size="sm" variant="ghost" className="w-full justify-start" action={() => restartWarmup(m.id)}><RotateCcw size={14} />Restart warm-up</ActionButton>
              <ActionButton size="sm" variant="ghost" className="w-full justify-start text-bad" confirm={`Remove ${m.email}? Sent history is kept.`} action={() => deleteMailbox(m.id)}><Trash2 size={14} />Remove</ActionButton>
            </div>
          )}
        </div>
      </div>

      <div className="mt-4 grid sm:grid-cols-[1fr_auto] items-center gap-x-6 gap-y-1">
        <Progress value={sentToday} max={limitToday} />
        <div className="text-[12.5px] tabular-nums text-muted">
          <span className="text-ink font-medium">{sentToday}</span> / {limitToday} today
          {warming && <span className="text-faint"> · full {m.daily_limit}/day from {fullCapacityDate(m)}</span>}
        </div>
      </div>
      {windowCapacity(m) < m.daily_limit && (
        <p className="mt-2 text-[12px] text-warn">
          With {hh(m.window_start)}–{hh(m.window_end)} and a {m.min_delay_sec}s minimum gap this mailbox can only send ~{windowCapacity(m)}/day. Widen the sending hours or lower the minimum gap.
        </p>
      )}

      <DomainHealth email={m.email} smtpHost={m.smtp_host} />

      {m.last_error && (
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-bad-soft text-bad px-3 py-2 text-[12.5px]">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span className="break-words">{m.last_error}</span>
        </div>
      )}

      {editing && <MailboxDialog initial={fromMailbox(m)} onClose={() => setEditing(false)} />}
      {testOpen && <TestDialog id={m.id} onClose={() => setTestOpen(false)} />}
    </Card>
  );
}

function fullCapacityDate(m: PublicMailbox): string {
  if (!m.warmup_enabled || m.warmup_increment <= 0) return "—";
  const days = Math.max(0, Math.ceil((Math.min(400, m.daily_limit) - m.warmup_start) / m.warmup_increment));
  const d = new Date(`${m.warmup_started_at}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function DomainHealth({ email, smtpHost }: { email: string; smtpHost: string }) {
  const [checks, setChecks] = useState<HealthCheck[] | null>(null);
  const [open, setOpen] = useState(false);
  const [selector, setSelector] = useState("");
  const [loading, start] = useTransition();
  const run = (sel?: string) => start(async () => setChecks(await checkMailboxDomain(email, smtpHost, sel)));
  useEffect(() => {
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email, smtpHost]);

  const bad = checks?.filter((c) => c.level !== "ok") ?? [];
  return (
    <div className="mt-3 rounded-lg border border-line">
      <button type="button" onClick={() => setOpen((v) => !v)} className="w-full flex flex-wrap items-center gap-2 px-3 py-2 text-[12.5px]">
        <ShieldCheck size={14} className="text-faint" />
        <span className="font-medium">Deliverability for {email.split("@")[1]}</span>
        {loading && !checks ? <Spinner className="text-faint" /> : checks?.map((c) => (
          <Badge key={c.key} tone={c.level === "ok" ? "good" : c.level === "warn" ? "warn" : "bad"}>{c.level === "ok" ? "✓" : "!"} {c.key.toUpperCase()}</Badge>
        ))}
        <ChevronDown size={14} className={cx("ml-auto text-muted transition-transform", open && "rotate-180")} />
      </button>
      {open && checks && (
        <div className="px-3 pb-3 grid gap-2 text-[12.5px] fade-in">
          {checks.map((c) => (
            <div key={c.key} className="grid gap-0.5">
              <div className="flex items-center gap-1.5 font-medium">
                {c.level === "ok" ? <Check size={13} className="text-good" /> : <AlertTriangle size={13} className={c.level === "warn" ? "text-warn" : "text-bad"} />}{c.label}
              </div>
              <div className="text-muted break-all pl-5">{c.detail}</div>
              {c.fix && <div className="pl-5 text-ink/80">{c.fix}</div>}
            </div>
          ))}
          {bad.some((c) => c.key === "dkim") && (
            <div className="flex gap-2 pl-5">
              <Input value={selector} onChange={(e) => setSelector(e.target.value)} placeholder="DKIM selector (from s= in a sent email's header)" className="h-8 text-[12.5px]" />
              <Button size="sm" onClick={() => run(selector)} disabled={loading || !selector.trim()}>Check</Button>
            </div>
          )}
          <Button size="sm" variant="ghost" className="justify-self-start" onClick={() => run(selector || undefined)} disabled={loading}>{loading ? <Spinner /> : <RotateCcw size={13} />}Re-check DNS</Button>
        </div>
      )}
    </div>
  );
}

function TestDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const [to, setTo] = useState("");
  const [pending, run] = useAction();
  return (
    <Dialog open onClose={onClose} title="Send a test email"
      description="Send to your own Gmail/Outlook and check whether it lands in Inbox or Spam."
      footer={<Button variant="primary" disabled={pending || !to} onClick={() => run(() => sendTestEmail(id, to), onClose)}>{pending && <Spinner />}Send</Button>}>
      <Field label="Send to"><Input type="email" value={to} autoFocus placeholder="you@gmail.com" onChange={(e) => setTo(e.target.value)} /></Field>
    </Dialog>
  );
}
