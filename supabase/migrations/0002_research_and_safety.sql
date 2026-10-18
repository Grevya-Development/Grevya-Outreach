-- 0002: company research + AI-written emails, crash-safe sending, atomic per-mailbox pacing.
-- Safe to run more than once.

-- ───────────────────────── company research cache ─────────────────────────
create table if not exists company_research (
  domain text primary key,
  status text not null default 'ok' check (status in ('ok','failed')),
  source text,                      -- 'direct' | 'reader'
  url text,
  title text not null default '',
  description text not null default '',
  content text not null default '', -- cleaned page text (truncated)
  tech text[] not null default '{}',-- detected from HTML (Shopify, Meta Pixel, HubSpot…)
  analysis jsonb,                   -- Groq summary: what they do, pains, fit, angle
  error text,
  fetched_at timestamptz not null default now(),
  analyzed_at timestamptz
);
alter table company_research enable row level security;

-- ───────────────────────── campaigns: AI mode ─────────────────────────
alter table campaigns add column if not exists mode text not null default 'template';
alter table campaigns drop constraint if exists campaigns_mode_check;
alter table campaigns add constraint campaigns_mode_check check (mode in ('template','ai'));
alter table campaigns add column if not exists min_fit_score smallint not null default 0;
alter table campaigns add column if not exists require_approval boolean not null default false;
alter table campaigns alter column daily_limit set default 1000;

-- ───────────────────────── campaign_leads: preparation pipeline ─────────────────────────
alter table campaign_leads add column if not exists prep_status text not null default 'pending';
alter table campaign_leads drop constraint if exists campaign_leads_prep_status_check;
alter table campaign_leads add constraint campaign_leads_prep_status_check
  check (prep_status in ('pending','working','review','ready','failed','skipped'));
alter table campaign_leads add column if not exists prep_error text;
alter table campaign_leads add column if not exists prep_locked_until timestamptz;
alter table campaign_leads add column if not exists prep_attempts int not null default 0;
alter table campaign_leads add column if not exists fit_score smallint;
alter table campaign_leads add column if not exists skip_reason text;
create index if not exists campaign_leads_prep_idx on campaign_leads (prep_status, created_at);

-- ───────────────────────── messages: crash-safe sending ─────────────────────────
alter table messages drop constraint if exists messages_status_check;
alter table messages add constraint messages_status_check check (status in ('sending','sent','bounced','failed'));
alter table messages add column if not exists to_domain text generated always as (lower(split_part(to_email, '@', 2))) stored;
-- Sender address, so deleting + re-adding a mailbox can't reset its daily count.
alter table messages add column if not exists from_email text;
create index if not exists messages_from_sent_idx on messages (from_email, sent_at desc);
create index if not exists messages_to_domain_idx on messages (to_domain, sent_at desc);
create index if not exists messages_lead_idx on messages (lead_id, sent_at desc);
-- One attempt per lead per step: a crash after SMTP can never cause a second send.
create unique index if not exists messages_one_per_step on messages (campaign_lead_id, step_number)
  where campaign_lead_id is not null and status <> 'failed';

-- IMAP: UIDVALIDITY lets us notice a mailbox/server change and resync from scratch.
alter table mailboxes add column if not exists imap_uidvalidity bigint;

-- Login throttling + misc counters live in app_state (already exists).

-- ───────────────────────── functions ─────────────────────────

-- Lead claim now also requires AI-prepared content for AI campaigns.
create or replace function claim_next_lead(p_mailbox uuid)
returns setof campaign_leads
language plpgsql
as $$
declare
  v_id uuid;
  v_tz text;
begin
  select timezone into v_tz from mailboxes where id = p_mailbox;
  with capped as (
    select c2.id from campaigns c2
    where c2.status = 'active'
      and (select count(*) from messages m
            where m.campaign_id = c2.id and m.status <> 'failed'
              and m.sent_at >= (date_trunc('day', now() at time zone coalesce(v_tz, 'UTC')) at time zone coalesce(v_tz, 'UTC'))
          ) >= c2.daily_limit
  )
  select cl.id into v_id
  from campaign_leads cl
  join campaigns c on c.id = cl.campaign_id and c.status = 'active'
  join campaign_mailboxes cm on cm.campaign_id = cl.campaign_id and cm.mailbox_id = p_mailbox
  where cl.status in ('queued','in_progress')
    and cl.next_send_at <= now()
    and (cl.locked_until is null or cl.locked_until < now())
    and (cl.mailbox_id is null or cl.mailbox_id = p_mailbox)
    and (c.mode = 'template' or cl.prep_status = 'ready')
    -- A campaign at its daily cap must not block other campaigns sharing this mailbox.
    and not exists (
      select 1 from capped where capped.id = c.id
    )
  order by cl.current_step desc, cl.next_send_at asc
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

-- Atomically reserves the next send slot for a mailbox: checks pacing and today's cap
-- under a row lock, then pushes next_available_at forward. Two engines can never both
-- get the same slot or exceed the cap.
create or replace function reserve_mailbox_slot(p_mailbox uuid, p_limit int, p_gap_sec int)
returns boolean
language plpgsql
as $$
declare
  m mailboxes%rowtype;
  v_sent bigint;
begin
  select * into m from mailboxes where id = p_mailbox and status = 'active' for update skip locked;
  if not found or m.next_available_at > now() then
    return false;
  end if;
  select count(*) into v_sent from messages
   where (mailbox_id = p_mailbox or from_email = m.email) and status <> 'failed'
     and sent_at >= (date_trunc('day', now() at time zone m.timezone) at time zone m.timezone);
  if v_sent >= least(p_limit, 400) then
    return false;
  end if;
  update mailboxes set next_available_at = now() + make_interval(secs => greatest(p_gap_sec, 10)) where id = p_mailbox;
  return true;
end;
$$;

-- Claims leads whose AI emails need writing. Stale 'working' rows (crashed worker) are retried.
create or replace function claim_prep(p_limit int)
returns setof campaign_leads
language plpgsql
as $$
begin
  return query
  with picked as (
    select cl.id
    from campaign_leads cl
    join campaigns c on c.id = cl.campaign_id and c.mode = 'ai' and c.status in ('draft','active','paused')
    where cl.status in ('queued','in_progress')
      and (cl.prep_status = 'pending' or (cl.prep_status = 'working' and cl.prep_locked_until < now()))
    order by (c.status = 'active') desc, cl.created_at
    limit p_limit
    for update of cl skip locked
  )
  update campaign_leads cl
     set prep_status = 'working', prep_locked_until = now() + interval '10 minutes', prep_attempts = cl.prep_attempts + 1
    from picked
   where cl.id = picked.id
  returning cl.*;
end;
$$;

-- Replaces a campaign's steps in one transaction (a tick can never see zero steps).
create or replace function replace_steps(p_campaign uuid, p_steps jsonb)
returns void
language plpgsql
as $$
begin
  delete from campaign_steps where campaign_id = p_campaign;
  insert into campaign_steps (campaign_id, step_number, delay_days, subject, body)
  select p_campaign, (s->>'step_number')::int, (s->>'delay_days')::int, coalesce(s->>'subject', ''), coalesce(s->>'body', '')
  from jsonb_array_elements(p_steps) s;
end;
$$;

create or replace function campaign_prep_counts(p_campaign uuid)
returns table (prep_status text, n bigint)
language sql stable
as $$
  select prep_status, count(*) from campaign_leads
  where campaign_id = p_campaign and status in ('queued','in_progress')
  group by prep_status;
$$;

-- Dashboard bounce count: bounced messages (SMTP rejections + IMAP bounce reports).
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
    (select count(*) from messages m where m.status = 'bounced' and (m.sent_at at time zone p_tz)::date = d.day)
  from days d
  order by d.day;
$$;

-- Bounce rate over a mailbox's most recent sends, for auto-pause.
create or replace function mailbox_recent_bounces(p_mailbox uuid, p_window int)
returns table (total bigint, bounced bigint)
language sql stable
as $$
  select count(*), count(*) filter (where status = 'bounced')
  from (select status from messages where mailbox_id = p_mailbox and status <> 'failed' order by sent_at desc limit p_window) t;
$$;

revoke execute on function reserve_mailbox_slot(uuid, int, int) from public, anon, authenticated;
revoke execute on function replace_steps(uuid, jsonb) from public, anon, authenticated;
revoke execute on function claim_prep(int) from public, anon, authenticated;
revoke execute on function campaign_prep_counts(uuid) from public, anon, authenticated;
revoke execute on function mailbox_recent_bounces(uuid, int) from public, anon, authenticated;
revoke execute on function claim_next_lead(uuid) from public, anon, authenticated;
revoke execute on function daily_activity(int, text) from public, anon, authenticated;
grant execute on function reserve_mailbox_slot(uuid, int, int), replace_steps(uuid, jsonb), claim_prep(int), campaign_prep_counts(uuid),
  mailbox_recent_bounces(uuid, int), claim_next_lead(uuid), daily_activity(int, text) to service_role;

-- Ask PostgREST to pick up the new columns/functions immediately.
notify pgrst, 'reload schema';
