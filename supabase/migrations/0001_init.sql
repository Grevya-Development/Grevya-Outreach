-- Grevya Outreach schema. Apply with `npm run db:setup` or paste into the Supabase SQL editor.
-- All access goes through the server with the service-role key; RLS is enabled with no
-- policies so the anon key can read nothing.

create extension if not exists pgcrypto;

-- ───────────────────────── mailboxes ─────────────────────────
create table if not exists mailboxes (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  from_name text not null default '',
  smtp_host text not null,
  smtp_port int not null default 465,
  smtp_secure boolean not null default true,
  imap_host text,
  imap_port int not null default 993,
  username text not null,
  password_enc text not null,
  -- Hard ceiling: provider allows 500/day, we never exceed 400.
  daily_limit int not null default 400 check (daily_limit between 1 and 400),
  warmup_enabled boolean not null default true,
  warmup_start int not null default 20 check (warmup_start between 1 and 400),
  warmup_increment int not null default 10 check (warmup_increment between 0 and 100),
  warmup_started_at date not null default current_date,
  min_delay_sec int not null default 60 check (min_delay_sec >= 10),
  max_delay_sec int not null default 180,
  timezone text not null default 'Asia/Kolkata',
  window_start smallint not null default 9 check (window_start between 0 and 23),
  window_end smallint not null default 18 check (window_end between 1 and 24),
  send_days smallint[] not null default '{1,2,3,4,5}', -- 0=Sun..6=Sat
  signature text not null default '',
  status text not null default 'active' check (status in ('active','paused','error')),
  last_error text,
  next_available_at timestamptz not null default now(),
  imap_last_uid bigint,
  imap_synced_at timestamptz,
  created_at timestamptz not null default now(),
  check (max_delay_sec >= min_delay_sec),
  check (window_end > window_start)
);

-- ───────────────────────── leads ─────────────────────────
create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  first_name text not null default '',
  last_name text not null default '',
  company text not null default '',
  title text not null default '',
  website text not null default '',
  linkedin text not null default '',
  phone text not null default '',
  city text not null default '',
  notes text not null default '',
  custom jsonb not null default '{}'::jsonb,
  tags text[] not null default '{}',
  status text not null default 'active' check (status in ('active','unsubscribed','bounced','invalid')),
  verify_status text check (verify_status in ('valid','invalid','risky','unknown')),
  created_at timestamptz not null default now()
);
create index if not exists leads_tags_idx on leads using gin (tags);
create index if not exists leads_created_idx on leads (created_at desc);

-- Emails we must never contact, even if re-imported.
create table if not exists suppressions (
  email text primary key,
  reason text not null default 'manual',
  created_at timestamptz not null default now()
);

-- ───────────────────────── campaigns ─────────────────────────
create table if not exists campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null default 'draft' check (status in ('draft','active','paused','completed')),
  daily_limit int not null default 400 check (daily_limit between 1 and 10000),
  track_opens boolean not null default false,
  track_clicks boolean not null default false,
  stop_on_reply boolean not null default true,
  include_unsubscribe boolean not null default true,
  ai_enabled boolean not null default true,
  ai_prompt text not null default '',
  sender_context text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists campaign_steps (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id) on delete cascade,
  step_number int not null,
  delay_days int not null default 0 check (delay_days >= 0),
  subject text not null default '',
  body text not null default '',
  unique (campaign_id, step_number)
);

create table if not exists campaign_mailboxes (
  campaign_id uuid not null references campaigns(id) on delete cascade,
  mailbox_id uuid not null references mailboxes(id) on delete cascade,
  primary key (campaign_id, mailbox_id)
);

create table if not exists campaign_leads (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id) on delete cascade,
  lead_id uuid not null references leads(id) on delete cascade,
  mailbox_id uuid references mailboxes(id) on delete set null,
  status text not null default 'queued'
    check (status in ('queued','in_progress','replied','bounced','unsubscribed','completed','failed','skipped')),
  current_step int not null default 0,          -- number of steps already sent
  next_send_at timestamptz not null default now(),
  locked_until timestamptz,
  personalization jsonb,                         -- { ai_line, generated_at }
  last_message_id text,
  last_subject text,
  attempts int not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  unique (campaign_id, lead_id)
);
create index if not exists campaign_leads_due_idx on campaign_leads (status, next_send_at);
create index if not exists campaign_leads_campaign_idx on campaign_leads (campaign_id, status);

-- ───────────────────────── messages & events ─────────────────────────
create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  campaign_lead_id uuid references campaign_leads(id) on delete set null,
  campaign_id uuid references campaigns(id) on delete set null,
  lead_id uuid references leads(id) on delete set null,
  mailbox_id uuid references mailboxes(id) on delete set null,
  step_number int not null,
  to_email text not null,
  subject text not null,
  body text not null,
  message_id text,
  status text not null default 'sent' check (status in ('sent','bounced','failed')),
  error text,
  sent_at timestamptz not null default now(),
  opened_at timestamptz,
  open_count int not null default 0,
  clicked_at timestamptz,
  click_count int not null default 0
);
create index if not exists messages_mailbox_sent_idx on messages (mailbox_id, sent_at desc);
create index if not exists messages_campaign_idx on messages (campaign_id, sent_at desc);
create index if not exists messages_sent_idx on messages (sent_at desc);
create index if not exists messages_message_id_idx on messages (message_id);

create table if not exists replies (
  id uuid primary key default gen_random_uuid(),
  mailbox_id uuid references mailboxes(id) on delete set null,
  lead_id uuid references leads(id) on delete set null,
  campaign_id uuid references campaigns(id) on delete set null,
  from_email text not null,
  from_name text not null default '',
  subject text not null default '',
  snippet text not null default '',
  body text not null default '',
  kind text not null default 'reply' check (kind in ('reply','auto_reply','bounce')),
  sentiment text check (sentiment in ('interested','not_interested','neutral')),
  is_read boolean not null default false,
  received_at timestamptz not null default now(),
  imap_uid bigint,
  unique (mailbox_id, imap_uid)
);
create index if not exists replies_received_idx on replies (received_at desc);

create table if not exists events (
  id bigint generated always as identity primary key,
  type text not null check (type in ('sent','open','click','reply','bounce','unsubscribe','error')),
  message_id uuid references messages(id) on delete set null,
  campaign_id uuid references campaigns(id) on delete set null,
  lead_id uuid references leads(id) on delete set null,
  mailbox_id uuid references mailboxes(id) on delete set null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists events_created_idx on events (created_at desc);
create index if not exists events_campaign_idx on events (campaign_id, type);

-- Engine heartbeat & misc key/value settings.
create table if not exists app_state (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- ───────────────────────── functions ─────────────────────────

-- Atomically claim the next due lead for a mailbox. First-step leads are claimed by
-- any mailbox assigned to the campaign; follow-ups stay on the mailbox that started
-- the thread. SKIP LOCKED + locked_until make concurrent engine ticks safe.
create or replace function claim_next_lead(p_mailbox uuid)
returns setof campaign_leads
language plpgsql
as $$
declare
  v_id uuid;
begin
  select cl.id into v_id
  from campaign_leads cl
  join campaigns c on c.id = cl.campaign_id and c.status = 'active'
  join campaign_mailboxes cm on cm.campaign_id = cl.campaign_id and cm.mailbox_id = p_mailbox
  where cl.status in ('queued','in_progress')
    and cl.next_send_at <= now()
    and (cl.locked_until is null or cl.locked_until < now())
    and (cl.mailbox_id is null or cl.mailbox_id = p_mailbox)
  order by cl.current_step desc, cl.next_send_at asc   -- follow-ups first, then oldest
  limit 1
  for update of cl skip locked;

  if v_id is null then
    return;
  end if;

  return query
    update campaign_leads
       set locked_until = now() + interval '5 minutes',
           mailbox_id = coalesce(mailbox_id, p_mailbox)
     where id = v_id
     returning *;
end;
$$;

-- Daily send counts per mailbox, using each mailbox's own timezone midnight.
create or replace function mailbox_sent_today()
returns table (mailbox_id uuid, sent bigint)
language sql stable
as $$
  select m.id, count(msg.id)
  from mailboxes m
  left join messages msg
    on msg.mailbox_id = m.id
   and msg.status <> 'failed'
   and msg.sent_at >= (date_trunc('day', now() at time zone m.timezone) at time zone m.timezone)
  group by m.id;
$$;

create or replace function campaign_sent_today(p_campaign uuid, p_tz text)
returns bigint
language sql stable
as $$
  select count(*) from messages
  where campaign_id = p_campaign
    and status <> 'failed'
    and sent_at >= (date_trunc('day', now() at time zone p_tz) at time zone p_tz);
$$;

-- Aggregated campaign stats for list/detail views.
create or replace function campaign_stats()
returns table (
  campaign_id uuid, leads bigint, sent bigint, opened bigint, clicked bigint,
  replied bigint, bounced bigint, unsubscribed bigint, remaining bigint
)
language sql stable
as $$
  select c.id,
    (select count(*) from campaign_leads cl where cl.campaign_id = c.id),
    (select count(*) from messages m where m.campaign_id = c.id and m.status <> 'failed'),
    (select count(*) from messages m where m.campaign_id = c.id and m.opened_at is not null),
    (select count(*) from messages m where m.campaign_id = c.id and m.clicked_at is not null),
    (select count(*) from campaign_leads cl where cl.campaign_id = c.id and cl.status = 'replied'),
    (select count(*) from campaign_leads cl where cl.campaign_id = c.id and cl.status = 'bounced'),
    (select count(*) from campaign_leads cl where cl.campaign_id = c.id and cl.status = 'unsubscribed'),
    (select count(*) from campaign_leads cl where cl.campaign_id = c.id and cl.status in ('queued','in_progress'))
  from campaigns c;
$$;

create or replace function campaign_status_counts(p_campaign uuid)
returns table (status text, n bigint)
language sql stable
as $$
  select status, count(*) from campaign_leads where campaign_id = p_campaign group by status;
$$;

-- Daily sends/replies for the dashboard chart.
create or replace function daily_activity(p_days int, p_tz text)
returns table (day date, sent bigint, opened bigint, replied bigint, bounced bigint)
language sql stable
as $$
  with days as (
    select generate_series(
      (now() at time zone p_tz)::date - (p_days - 1),
      (now() at time zone p_tz)::date,
      interval '1 day'
    )::date as day
  )
  select d.day,
    (select count(*) from messages m where m.status <> 'failed' and (m.sent_at at time zone p_tz)::date = d.day),
    (select count(*) from messages m where m.opened_at is not null and (m.opened_at at time zone p_tz)::date = d.day),
    (select count(*) from replies r where r.kind = 'reply' and (r.received_at at time zone p_tz)::date = d.day),
    -- Covers SMTP-time rejections and bounce emails found by IMAP (both mark the message bounced).
    (select count(*) from messages m where m.status = 'bounced' and (m.sent_at at time zone p_tz)::date = d.day)
  from days d
  order by d.day;
$$;

-- Tag list with counts for the leads filter.
create or replace function lead_tags()
returns table (tag text, n bigint)
language sql stable
as $$
  select t, count(*) from leads, unnest(tags) t group by t order by t;
$$;

-- Add leads to a campaign by tag (or all when p_tag is null), skipping suppressed/bad ones.
create or replace function enroll_leads(p_campaign uuid, p_tag text, p_lead_ids uuid[] default null)
returns int
language plpgsql
as $$
declare
  n int;
begin
  insert into campaign_leads (campaign_id, lead_id)
  select p_campaign, l.id
  from leads l
  where l.status = 'active'
    and coalesce(l.verify_status, 'unknown') <> 'invalid'
    and not exists (select 1 from suppressions s where s.email = l.email)
    and (p_lead_ids is not null and l.id = any(p_lead_ids)
         or p_lead_ids is null and (p_tag is null or p_tag = any(l.tags)))
  on conflict (campaign_id, lead_id) do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;

alter table mailboxes enable row level security;
alter table leads enable row level security;
alter table suppressions enable row level security;
alter table campaigns enable row level security;
alter table campaign_steps enable row level security;
alter table campaign_mailboxes enable row level security;
alter table campaign_leads enable row level security;
alter table messages enable row level security;
alter table replies enable row level security;
alter table events enable row level security;
alter table app_state enable row level security;

-- Functions are only callable by the service role.
revoke execute on function claim_next_lead(uuid) from public, anon, authenticated;
revoke execute on function mailbox_sent_today() from public, anon, authenticated;
revoke execute on function campaign_sent_today(uuid, text) from public, anon, authenticated;
revoke execute on function campaign_stats() from public, anon, authenticated;
revoke execute on function daily_activity(int, text) from public, anon, authenticated;
revoke execute on function lead_tags() from public, anon, authenticated;
revoke execute on function campaign_status_counts(uuid) from public, anon, authenticated;
revoke execute on function enroll_leads(uuid, text, uuid[]) from public, anon, authenticated;
grant execute on function claim_next_lead(uuid), mailbox_sent_today(), campaign_sent_today(uuid, text),
  campaign_stats(), daily_activity(int, text), lead_tags(), campaign_status_counts(uuid), enroll_leads(uuid, text, uuid[]) to service_role;
