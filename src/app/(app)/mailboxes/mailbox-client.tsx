"use client";

import { AlertTriangle, Check, ChevronDown, Copy, Eye, EyeOff, MoreHorizontal, Pause, Pencil, Play, Plus, RotateCcw, Send, ShieldCheck, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import {
  deleteMailbox, recheckDomain, restartWarmup, saveMailbox, sendTestEmail, setMailboxStatus, testMailbox,
  type ConnectionTest, type MailboxInput,
} from "@/app/actions/mailboxes";
import { ActionButton, Dialog, Menu, RelativeTime, Spinner, Switch, useAction, useConfirm } from "@/components/client";
import { Button, Card, Field, Input, Progress, Select, StatusBadge, Textarea, cx } from "@/components/ui";
import type { SendingSchedule } from "@/lib/app-state";
import type { HealthCheck } from "@/lib/domain-health";
import { PROVIDERS, type CheckResult, type ProviderKey } from "@/lib/providers";
import { MAILBOX_HARD_CAP, windowCapacity } from "@/lib/schedule";
import type { PublicMailbox } from "@/lib/types";

const DAYS = ["S", "M", "T", "W", "T", "F", "S"];
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;
const TIMEZONES = ["Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Europe/London", "Europe/Berlin", "America/New_York", "America/Chicago", "America/Los_Angeles", "Australia/Sydney", "UTC"];
const HOUR_FIELDS: (keyof MailboxInput)[] = ["timezone", "window_start", "window_end", "send_days"];

/** A new account: GoDaddy servers until the provider is detected, hours from Settings → Sending. */
function blank(schedule?: SendingSchedule): MailboxInput {
  return {
    email: "", from_name: "", ...PROVIDERS.godaddy, username: "", password: "",
    daily_limit: MAILBOX_HARD_CAP, warmup_enabled: true, warmup_start: 20, warmup_increment: 10,
    min_delay_sec: 60, max_delay_sec: 180, timezone: "Asia/Kolkata", window_start: 9, window_end: 18,
    send_days: [1, 2, 3, 4, 5], ...schedule, signature: "", save_to_sent: true,
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

const dayList = (days: number[]) => DAY_NAMES.filter((_, i) => days.includes(i)).join(" ");

export function AddMailboxButton({ defaultOpen = false, schedule, variant = "primary" }: {
  /** Open straight away (/mailboxes?connect=1). */
  defaultOpen?: boolean;
  /** Settings → Sending, used as the new account's hours. */
  schedule?: SendingSchedule;
  variant?: "primary" | "secondary";
}) {
  const router = useRouter();
  const [open, setOpen] = useState(defaultOpen);
  const close = () => {
    setOpen(false);
    if (defaultOpen) router.replace("/mailboxes", { scroll: false }); // drop ?connect=1 so a reload doesn't reopen it
  };
  return (
    <>
      <Button variant={variant} onClick={() => setOpen(true)}><Plus size={15} />Connect account</Button>
      {open && <MailboxDialog initial={blank(schedule)} onClose={close} />}
    </>
  );
}

function MailboxDialog({ initial, onClose }: { initial: MailboxInput; onClose: () => void }) {
  const router = useRouter();
  const isEdit = Boolean(initial.id);
  const [f, setF] = useState(initial);
  const [showPw, setShowPw] = useState(false);
  // undefined = not looked up yet, null = couldn't tell.
  const [detected, setDetected] = useState<ProviderKey | null | undefined>(undefined);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [result, setResult] = useState<ConnectionTest | null>(null);
  const [busy, start] = useTransition();
  const [phase, setPhase] = useState<"idle" | "testing" | "saving">("idle");
  const set = <K extends keyof MailboxInput>(k: K, v: MailboxInput[K]) => {
    // Touching the hours of a new account means "don't use the global schedule".
    setF((p) => ({ ...p, [k]: v, ...(!isEdit && HOUR_FIELDS.includes(k) ? { custom_hours: true } : {}) }));
    setResult(null);
  };
  const preset = presetOf(f);
  const resultRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (result || phase === "testing") resultRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [result, phase]);

  // Pick the provider from the domain's MX records, a moment after the user stops typing.
  const detectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const detectCall = useRef<AbortController | null>(null);
  useEffect(() => () => { clearTimeout(detectTimer.current); detectCall.current?.abort(); }, []);
  const onEmail = (email: string) => {
    set("email", email);
    if (isEdit) return;
    clearTimeout(detectTimer.current);
    detectCall.current?.abort(); // the user kept typing
    const domain = email.split("@")[1];
    if (!domain || !domain.includes(".")) { setDetected(undefined); return; }
    detectTimer.current = setTimeout(async () => {
      const ac = new AbortController();
      detectCall.current = ac;
      const p = await fetch(`/api/mailboxes/detect?email=${encodeURIComponent(email)}`, { signal: ac.signal, cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<{ provider: ProviderKey | null }>) : { provider: null }))
        .then((d) => d.provider)
        .catch(() => undefined);
      if (ac.signal.aborted || p === undefined) return;
      setDetected(p);
      if (p) {
        const cfg = PROVIDERS[p];
        setF((prev) => ({ ...prev, smtp_host: cfg.smtp_host, smtp_port: cfg.smtp_port, smtp_secure: cfg.smtp_secure, imap_host: cfg.imap_host, imap_port: cfg.imap_port }));
      } else setShowAdvanced(true);
    }, 500);
  };

  const test = (thenSave: boolean, force = false, override: Partial<MailboxInput> = {}) => start(async () => {
    try {
      let r = result;
      if (!force) {
        setPhase("testing");
        setResult(null);
        r = await testMailbox(f, PROVIDERS[preset].label);
        setResult(r);
        if (!r.smtp.ok) setShowAdvanced(true);
      }
      if (thenSave && (force || r?.smtp.ok)) {
        setPhase("saving");
        const s = await saveMailbox({ ...f, ...override });
        if (!s.ok) { toast.error(s.error); return; }
        const next = s.action;
        toast.success(s.message ?? "Saved", next ? { action: { label: next.label, onClick: () => router.push(next.href) } } : undefined);
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
  const domain = f.email.split("@")[1];

  return (
    <Dialog
      open
      onClose={onClose}
      title={isEdit ? `Edit ${initial.email}` : "Connect an email account"}
      description={isEdit ? "Leave the password blank to keep the current one." : "We check the login before saving. Nothing is sent."}
      footer={
        <>
          {isEdit && <Button type="button" onClick={() => test(false)} disabled={busy}>{phase === "testing" ? <Spinner /> : null}Test connection</Button>}
          {smtpOkImapBad && <Button type="button" onClick={() => test(true, true, { imap_host: "" })} disabled={busy}>Save anyway (replies won&apos;t be picked up)</Button>}
          <Button type="button" variant="primary" disabled={busy || !canSubmit} onClick={() => test(true, isEdit && !f.password && !result)}>
            {busy && <Spinner />}
            {phase === "testing" ? "Checking login…" : phase === "saving" ? "Saving…" : isEdit ? "Save" : "Connect"}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4">
        <Field
          label="Email address"
          hint={!isEdit && detected && detected === preset ? <span className="text-good">Looks like {PROVIDERS[detected].label}, settings filled in</span>
            : !isEdit && detected === null && domain ? <>Couldn&apos;t tell who hosts {domain}. Pick the provider under Advanced → Server settings.</>
            : undefined}
        >
          <Input value={f.email} type="email" autoFocus={!isEdit} data-autofocus={!isEdit ? "" : undefined} placeholder="info@grevya.com"
            onChange={(e) => onEmail(e.target.value.trim())} disabled={isEdit} />
        </Field>
        <Field label="Email password" hint={preset === "godaddy" ? "The password you use to log in to this inbox at email.secureserver.net, not your GoDaddy account password." : preset === "google" ? "Use a Google App Password." : undefined}>
          <div className="relative">
            <Input type={showPw ? "text" : "password"} value={f.password} autoComplete="new-password" placeholder={isEdit ? "••••••••  (unchanged)" : ""}
              data-autofocus={isEdit ? "" : undefined} onChange={(e) => set("password", e.target.value)} className="pr-10" />
            <button type="button" onClick={() => setShowPw((v) => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-faint hover:text-ink" aria-label={showPw ? "Hide password" : "Show password"}>
              {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
        </Field>
        <Field label="Your name" hint="Shown to recipients, and fills {{sender_name}} in emails">
          <Input value={f.from_name} placeholder="Kavin from Grevya" onChange={(e) => set("from_name", e.target.value)} />
        </Field>
        <Field label="Signature" hint="Added under every email">
          <Textarea rows={3} value={f.signature} placeholder={"Kavin\nGrevya · grevya.com"} onChange={(e) => set("signature", e.target.value)} />
        </Field>

        {/* Result */}
        <div ref={resultRef} className="empty:hidden grid grid-cols-1 gap-2">
          {phase === "testing" && (
            <div className="flex items-center gap-2 rounded-lg bg-panel-2 px-3 py-3 text-[13px] text-muted fade-in">
              <Spinner />Signing in to {f.smtp_host || "the server"}… this takes a few seconds.
            </div>
          )}
          {result && (
            <div className="grid grid-cols-1 gap-2 fade-in" aria-live="polite">
              <CheckRow label="Sending" r={result.smtp} />
              <CheckRow label="Reply detection" r={result.imap ?? { ok: false, message: "No incoming (IMAP) server set, so replies and bounces won't be picked up." }} />
            </div>
          )}
        </div>

        {/* Advanced: server, limits, hours */}
        <div className="rounded-lg border border-line">
          <button type="button" onClick={() => setShowAdvanced((v) => !v)} aria-expanded={showAdvanced}
            className="w-full flex items-center gap-2 px-3 py-2.5 text-left text-[13px]">
            <div className="min-w-0 flex-1">
              <div className="font-medium">Advanced</div>
              <div className="text-[12px] text-muted truncate">
                {PROVIDERS[preset].label} · up to {f.daily_limit}/day · {f.warmup_enabled ? `warm-up ${f.warmup_start} → +${f.warmup_increment}/day` : "no warm-up"} · {hh(f.window_start)}–{hh(f.window_end)} {dayList(f.send_days)}
              </div>
            </div>
            <ChevronDown size={14} className={cx("ml-auto shrink-0 text-muted transition-transform", showAdvanced && "rotate-180")} />
          </button>
          {showAdvanced && (
            <div className="grid grid-cols-1 gap-5 px-3 pb-3 fade-in">
              <section className="grid grid-cols-1 gap-3">
                <h3 className="text-[12.5px] font-semibold text-muted uppercase tracking-wide">Server settings</h3>
                <Field label="Provider">
                  <Select value={preset} onChange={(e) => {
                    const p = PROVIDERS[e.target.value as ProviderKey];
                    setF((prev) => ({ ...prev, smtp_host: p.smtp_host, smtp_port: p.smtp_port, smtp_secure: p.smtp_secure, imap_host: p.imap_host, imap_port: p.imap_port }));
                    setResult(null);
                  }}>
                    {(Object.keys(PROVIDERS) as ProviderKey[]).map((k) => <option key={k} value={k}>{PROVIDERS[k].label}</option>)}
                  </Select>
                </Field>
                <div className="grid grid-cols-[minmax(0,1fr)_80px] gap-2">
                  <Field label="SMTP server (sending)"><Input value={f.smtp_host} onChange={(e) => set("smtp_host", e.target.value.trim())} /></Field>
                  <Field label="Port"><Input type="number" value={f.smtp_port} onChange={(e) => { const p = Number(e.target.value); setF((prev) => ({ ...prev, smtp_port: p, smtp_secure: p === 465 })); setResult(null); }} /></Field>
                  <Field label="IMAP server (replies)"><Input value={f.imap_host} onChange={(e) => set("imap_host", e.target.value.trim())} /></Field>
                  <Field label="Port"><Input type="number" value={f.imap_port} onChange={(e) => set("imap_port", Number(e.target.value))} /></Field>
                </div>
                <Field label="Login username" hint="Usually the full email address"><Input value={f.username} placeholder={f.email || "same as email"} onChange={(e) => set("username", e.target.value.trim())} /></Field>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-[13px] font-medium">Save copies to the Sent folder</div>
                    <div className="text-[12px] text-muted">So every email the app sends also shows up in your normal email app, and conversations look complete.</div>
                  </div>
                  <Switch checked={f.save_to_sent ?? true} onChange={(v) => set("save_to_sent", v)} label="Save to Sent" />
                </div>
              </section>

              <section className="grid grid-cols-1 gap-3">
                <h3 className="text-[12.5px] font-semibold text-muted uppercase tracking-wide">Sending limits</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Field label="Daily limit" hint={`Up to ${MAILBOX_HARD_CAP}/day per account (safety limit)`}>
                    <Input type="number" min={1} max={MAILBOX_HARD_CAP} value={f.daily_limit} onChange={(e) => set("daily_limit", Math.min(MAILBOX_HARD_CAP, Number(e.target.value)))} />
                  </Field>
                  <Field label="Minimum gap (seconds)" hint="Emails are spread across your sending hours with random gaps, never closer than this.">
                    <Input type="number" min={10} value={f.min_delay_sec} onChange={(e) => { const v = Number(e.target.value); setF((p) => ({ ...p, min_delay_sec: v, max_delay_sec: Math.max(v, p.max_delay_sec) })); }} />
                  </Field>
                </div>
                <div className="rounded-lg bg-panel-2/60 p-3 grid grid-cols-1 gap-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[13px] font-medium">Warm-up</div>
                      <div className="text-[12px] text-muted">Start small and add a few more each day. Keeps a new account out of spam folders.</div>
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
                          ? `Starting at ${f.warmup_start}/day is risky for an account that hasn't sent cold email before. 20 is safer.`
                          : `Reaches ${f.daily_limit}/day after ${f.warmup_increment > 0 ? Math.max(0, Math.ceil((f.daily_limit - f.warmup_start) / f.warmup_increment)) : "∞"} days.`}
                      </p>
                    </>
                  )}
                </div>
              </section>

              <section className="grid grid-cols-1 gap-3">
                <div>
                  <h3 className="text-[12.5px] font-semibold text-muted uppercase tracking-wide">Account sending hours</h3>
                  <p className="text-[12px] text-muted mt-0.5">New accounts use the schedule from Settings → Sending. Campaigns send inside these hours.</p>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Field label="Timezone">
                    <Select value={f.timezone} onChange={(e) => set("timezone", e.target.value)}>
                      {(TIMEZONES.includes(f.timezone) ? TIMEZONES : [f.timezone, ...TIMEZONES]).map((t) => <option key={t}>{t}</option>)}
                    </Select>
                  </Field>
                  <Field label="Sending hours">
                    <div className="flex items-center gap-1.5">
                      <Select value={f.window_start} aria-label="From" onChange={(e) => set("window_start", Number(e.target.value))}>
                        {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hh(h)}</option>)}
                      </Select>
                      <Select value={f.window_end} aria-label="Until" onChange={(e) => set("window_end", Number(e.target.value))}>
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
              </section>
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

/**
 * One email account. Everything that depends on the clock or locale (today's limit, the sending
 * window, the warm-up date) is worked out on the server and passed in, so it hydrates cleanly.
 */
export function MailboxCard({ mailbox: m, sentToday, limitToday, inWindow, fullDate, campaignNames, health, openTest = false }: {
  mailbox: PublicMailbox;
  sentToday: number;
  limitToday: number;
  inWindow: boolean;
  /** When warm-up reaches the full daily limit ('25 Nov'). */
  fullDate: string | null;
  /** Unfinished campaigns that send from this account. */
  campaignNames: string[];
  /** The server-rendered domain health section. */
  health: ReactNode;
  /** /mailboxes?test=<id>: open "Send a test email" (offered after connecting). */
  openTest?: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [pending, run] = useAction();
  const { confirm, element: confirmDialog } = useConfirm();

  // ?test=<id> opens the test dialog until it's closed; a later ?test=<id> opens it again.
  const [urlTestClosed, setUrlTestClosed] = useState(false);
  const [prevOpenTest, setPrevOpenTest] = useState(openTest);
  if (prevOpenTest !== openTest) {
    setPrevOpenTest(openTest);
    if (!openTest) setUrlTestClosed(false);
  }
  const showTest = testOpen || (openTest && !urlTestClosed);
  const closeTest = () => {
    setTestOpen(false);
    if (openTest) {
      setUrlTestClosed(true);
      router.replace("/mailboxes", { scroll: false });
    }
  };

  const cap = Math.min(MAILBOX_HARD_CAP, m.daily_limit);
  const warming = m.warmup_enabled && limitToday < cap;
  const preset = presetOf(m);
  const provider = preset === "custom" ? m.smtp_host : PROVIDERS[preset].label;

  const remove = async () => {
    const ok = await confirm({
      title: `Remove ${m.email}?`,
      body: (
        <>
          Sent history is kept.
          {campaignNames.length > 0 && <> Used by: <span className="text-ink">{campaignNames.join(", ")}</span>. Those campaigns keep sending from their other accounts.</>}
        </>
      ),
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (ok) run(() => deleteMailbox(m.id));
  };
  const restart = async () => {
    const ok = await confirm({
      title: "Restart warm-up?",
      body: `${m.email} goes back to ${m.warmup_start}/day and adds ${m.warmup_increment} more each day.`,
      confirmLabel: "Restart warm-up",
    });
    if (ok) run(() => restartWarmup(m.id));
  };

  return (
    <Card className="p-4 fade-in">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium truncate">{m.email}</span>
            <StatusBadge status={m.status} kind="mailbox" />
          </div>
          <div className="text-[12.5px] text-muted mt-1">
            {m.from_name || "No sender name"} · {provider}
          </div>
          <div className="text-[12.5px] text-muted mt-0.5">
            {hh(m.window_start)}–{hh(m.window_end)} {m.timezone}
            {m.status === "active" && !inWindow && <span className="text-faint"> · outside sending hours</span>}
            {" · "}
            {!m.imap_host ? "Reply detection off"
              : m.imap_synced_at ? <>Inbox checked <RelativeTime iso={m.imap_synced_at} /></>
              : "Inbox not checked yet"}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {m.status === "active"
            ? <ActionButton size="sm" action={() => setMailboxStatus(m.id, "paused")}><Pause size={14} />Pause</ActionButton>
            : <ActionButton size="sm" variant="primary" action={() => setMailboxStatus(m.id, "active")}><Play size={14} />Resume</ActionButton>}
          <Menu
            trigger={
              <Button size="sm" variant="ghost" className="w-8 px-0" aria-label={`More actions for ${m.email}`} disabled={pending}>
                {pending ? <Spinner /> : <MoreHorizontal size={16} />}
              </Button>
            }
            items={[
              { label: "Edit", icon: <Pencil />, onSelect: () => setEditing(true) },
              { label: "Send test email", icon: <Send />, onSelect: () => setTestOpen(true) },
              { label: "Restart warm-up", icon: <RotateCcw />, onSelect: restart, hidden: !m.warmup_enabled },
              { label: "Remove", icon: <Trash2 />, onSelect: remove, tone: "danger" },
            ]}
          />
        </div>
      </div>

      <div className="mt-4 grid sm:grid-cols-[1fr_auto] items-center gap-x-6 gap-y-1">
        <Progress value={sentToday} max={limitToday} />
        <div className="text-[12.5px] tabular-nums text-muted">
          <span className="text-ink font-medium">{sentToday}</span> of {limitToday} sent today
        </div>
      </div>
      {warming && (
        <p className="mt-1.5 text-[12px] text-muted">
          Warming up · {limitToday}/day now{fullDate && `, full ${cap}/day from ${fullDate}`}
        </p>
      )}
      {windowCapacity(m) < cap && (
        <p className="mt-2 text-[12px] text-warn">
          With {hh(m.window_start)}–{hh(m.window_end)} and a {m.min_delay_sec}s minimum gap this account can only send about {windowCapacity(m)}/day. Widen the sending hours or lower the minimum gap.
        </p>
      )}

      {health}

      {m.last_error && (
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-bad-soft text-bad px-3 py-2 text-[12.5px]">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span className="break-words">{m.last_error}</span>
        </div>
      )}

      {editing && <MailboxDialog initial={fromMailbox(m)} onClose={() => setEditing(false)} />}
      {showTest && <TestDialog id={m.id} onClose={closeTest} />}
      {confirmDialog}
    </Card>
  );
}

const HEALTH_ORDER: HealthCheck["key"][] = ["spf", "dkim", "dmarc", "mx"];
const HEALTH_CAPTION: Record<HealthCheck["key"], string> = {
  spf: "Proves it's you",
  dkim: "Signs your emails",
  dmarc: "Tells receivers what to do",
  mx: "Can receive mail",
};

/** The DNS record (or SPF include) inside a fix, so it can be copied as-is. */
function recordIn(fix?: string): string | null {
  if (!fix) return null;
  const rec = fix.match(/\bv=(?:spf1|DMARC1)\b.*$/i)?.[0] ?? fix.match(/\binclude:[^\s]+/i)?.[0].replace(/\.$/, "");
  return rec?.trim() || null;
}

function CopyButton({ text }: { text: string }) {
  return (
    <Button type="button" size="sm" variant="ghost" className="h-7 px-2 shrink-0" aria-label="Copy record"
      onClick={() => navigator.clipboard.writeText(text).then(() => toast.success("Copied"), () => toast.error("Couldn't copy. Select the text instead."))}>
      <Copy size={13} />Copy
    </Button>
  );
}

/** SPF / DKIM / DMARC / MX badges, with fixes on expand. `checks` comes from the cached server check. */
export function DomainHealthView({ domain, checks, smtpHost }: { domain: string; checks: HealthCheck[] | null; smtpHost: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [selector, setSelector] = useState("");
  // A check with a custom DKIM selector isn't cached, so its result is kept here.
  const [withSelector, setWithSelector] = useState<HealthCheck[] | null>(null);
  const [loading, start] = useTransition();
  const shown = withSelector ?? checks;
  const ordered = shown ? HEALTH_ORDER.map((k) => shown.find((c) => c.key === k)).filter((c): c is HealthCheck => !!c) : [];
  const bad = ordered.filter((c) => c.level !== "ok");

  const recheck = (sel?: string) => start(async () => {
    try {
      setWithSelector(await recheckDomain(domain, smtpHost, sel));
      router.refresh();
    } catch (err) {
      toast.error((err as Error).message || "Couldn't check DNS");
    }
  });

  const recheckButton = (
    <Button size="sm" variant="ghost" onClick={() => recheck(selector.trim() || undefined)} disabled={loading}>
      {loading ? <Spinner /> : <RotateCcw size={13} />}Re-check DNS
    </Button>
  );

  return (
    <div className="mt-3 rounded-lg border border-line">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
        className="w-full flex items-center gap-2 px-3 pt-2.5 pb-2 text-left text-[12.5px]">
        <ShieldCheck size={14} className="text-faint shrink-0" />
        <span className="font-medium min-w-0 truncate">Deliverability for {domain}</span>
        <span className={cx("ml-auto shrink-0", shown ? (bad.length ? "text-warn" : "text-good") : "text-muted")}>
          {!shown ? "" : bad.length ? `${bad.length} to fix` : "All good"}
        </span>
        <ChevronDown size={14} className={cx("shrink-0 text-muted transition-transform", open && "rotate-180")} />
      </button>

      {shown ? (
        <ul className="grid grid-cols-2 sm:grid-cols-4 gap-2 px-3 pb-3">
          {ordered.map((c) => (
            <li key={c.key} className={cx("flex items-start gap-1.5 rounded-md px-2.5 py-1.5",
              c.level === "ok" ? "bg-good-soft" : c.level === "warn" ? "bg-warn-soft" : "bg-bad-soft")}>
              {c.level === "ok"
                ? <Check size={13} className="mt-0.5 shrink-0 text-good" />
                : <AlertTriangle size={13} className={cx("mt-0.5 shrink-0", c.level === "warn" ? "text-warn" : "text-bad")} />}
              <div className="min-w-0">
                <div className="text-[12px] font-semibold text-ink">
                  {c.key.toUpperCase()}<span className="sr-only">: {c.level === "ok" ? "set up" : "needs a fix"}</span>
                </div>
                <div className="text-[11.5px] text-muted leading-snug">{HEALTH_CAPTION[c.key]}</div>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex flex-wrap items-center gap-2 px-3 pb-3 text-[12.5px] text-muted">
          Couldn&apos;t check DNS for {domain} right now.{recheckButton}
        </div>
      )}

      {open && shown && (
        <div className="px-3 pb-3 grid gap-3 text-[12.5px] border-t border-line pt-3 fade-in">
          {ordered.map((c) => {
            const record = recordIn(c.fix);
            return (
              <div key={c.key} className="grid gap-0.5">
                <div className="flex items-center gap-1.5 font-medium">
                  {c.level === "ok" ? <Check size={13} className="text-good" /> : <AlertTriangle size={13} className={c.level === "warn" ? "text-warn" : "text-bad"} />}
                  {c.label}
                </div>
                <div className="text-muted break-all pl-5">{c.detail}</div>
                {c.fix && <div className="pl-5 text-ink/80">{c.fix}</div>}
                {record && (
                  <div className="ml-5 mt-1 flex items-center gap-2 rounded-md bg-panel-2 pl-2.5 pr-1 py-1">
                    <code className="min-w-0 flex-1 break-all font-mono text-[12px]">{record}</code>
                    <CopyButton text={record} />
                  </div>
                )}
                {c.key === "dkim" && c.level !== "ok" && (
                  <div className="flex gap-2 pl-5 mt-1">
                    <Input value={selector} onChange={(e) => setSelector(e.target.value)} aria-label="DKIM selector"
                      placeholder="DKIM selector (s= in a sent email's header)" className="h-8 text-[12.5px]" />
                    <Button size="sm" onClick={() => recheck(selector.trim())} disabled={loading || !selector.trim()}>Check</Button>
                  </div>
                )}
              </div>
            );
          })}
          <div className="justify-self-start -ml-2.5">{recheckButton}</div>
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
      description="Send it to your own Gmail or Outlook and check whether it lands in Inbox or Spam."
      footer={<Button variant="primary" disabled={pending || !to.includes("@")} onClick={() => run(() => sendTestEmail(id, to), onClose)}>{pending && <Spinner />}Send</Button>}>
      <Field label="Send to">
        <Input type="email" value={to} autoFocus data-autofocus="" placeholder="you@gmail.com" onChange={(e) => setTo(e.target.value.trim())}
          onKeyDown={(e) => { if (e.key === "Enter" && to.includes("@") && !pending) run(() => sendTestEmail(id, to), onClose); }} />
      </Field>
    </Dialog>
  );
}
