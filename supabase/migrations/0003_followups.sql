-- 0003: replying from the app, follow-up reminders, manual one-off emails, Sent-folder copies.
-- Safe to run more than once.

-- Replies: thread info so we can answer in the same thread, plus follow-up tracking.
alter table replies add column if not exists message_id text;
alter table replies add column if not exists references_header text;
alter table replies add column if not exists handled boolean not null default false;
alter table replies add column if not exists follow_up_at timestamptz;
alter table replies add column if not exists answered_at timestamptz;
alter table replies add column if not exists note text not null default '';
create index if not exists replies_follow_up_idx on replies (follow_up_at) where follow_up_at is not null and handled = false;

-- Messages: campaign emails vs. emails you write yourself (replies, one-offs).
alter table messages add column if not exists kind text not null default 'campaign';
alter table messages drop constraint if exists messages_kind_check;
alter table messages add constraint messages_kind_check check (kind in ('campaign','manual'));
alter table messages add column if not exists reply_id uuid references replies(id) on delete set null;

-- Mailboxes: keep a copy of everything we send in the mailbox's Sent folder, so threads
-- look complete in Gmail/Outlook/GoDaddy webmail.
alter table mailboxes add column if not exists save_to_sent boolean not null default true;
alter table mailboxes add column if not exists sent_folder text;

-- E-mail verifier: cache of checked addresses (saves time and API credits).
create table if not exists email_checks (
  email text primary key,
  status text not null check (status in ('valid','invalid','risky','unknown')),
  score smallint not null default 0,
  result jsonb not null default '{}'::jsonb,
  checked_at timestamptz not null default now()
);
alter table email_checks enable row level security;

-- AI claim: a pending lead whose last attempt failed waits until prep_locked_until ("not before").
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
      and cl.current_step = 0
      and (
        (cl.prep_status = 'pending' and (cl.prep_locked_until is null or cl.prep_locked_until < now()))
        or (cl.prep_status = 'working' and cl.prep_locked_until < now())
      )
    order by (c.status = 'active') desc, cl.created_at
    limit p_limit
    for update of cl skip locked
  )
  update campaign_leads cl
     set prep_status = 'working', prep_locked_until = clock_timestamp() + interval '10 minutes', prep_attempts = cl.prep_attempts + 1
    from picked
   where cl.id = picked.id
  returning cl.*;
end;
$$;

-- Slot reservation now returns the reserved timestamp (null = not reserved), so an engine can
-- give back *its* slot without clobbering a newer reservation made by another engine.
drop function if exists reserve_mailbox_slot(uuid, int, int);
create or replace function reserve_mailbox_slot(p_mailbox uuid, p_limit int, p_gap_sec int)
returns timestamptz
language plpgsql
as $$
declare
  m mailboxes%rowtype;
  v_sent bigint;
  v_next timestamptz;
begin
  select * into m from mailboxes where id = p_mailbox and status = 'active' for update skip locked;
  if not found or m.next_available_at > now() then
    return null;
  end if;
  select count(*) into v_sent from messages
   where (mailbox_id = p_mailbox or from_email = m.email) and status <> 'failed'
     and sent_at >= (date_trunc('day', now() at time zone m.timezone) at time zone m.timezone);
  if v_sent >= least(p_limit, 400) then
    return null;
  end if;
  v_next := clock_timestamp() + make_interval(secs => greatest(p_gap_sec, 10));
  update mailboxes set next_available_at = v_next where id = p_mailbox;
  return v_next;
end;
$$;

revoke execute on function reserve_mailbox_slot(uuid, int, int) from public, anon, authenticated;
revoke execute on function claim_prep(int) from public, anon, authenticated;
grant execute on function reserve_mailbox_slot(uuid, int, int), claim_prep(int) to service_role;

notify pgrst, 'reload schema';
