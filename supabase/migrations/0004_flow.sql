-- 0004: Optional: reply labels, blocked status, sequence confirmation, fast counts. Safe to run more than once.
-- The app works without it (it falls back to slower queries and hides reply labels).

-- ───────────────────────── wider status values ─────────────────────────

-- Reply labels beyond interested / not interested.
alter table replies drop constraint if exists replies_sentiment_check;
alter table replies add constraint replies_sentiment_check
  check (sentiment in ('interested','not_interested','neutral','meeting_booked','out_of_office','wrong_person','closed'));

-- Leads you block (Not interested / Wrong person / Block list) get their own status.
alter table leads drop constraint if exists leads_status_check;
alter table leads add constraint leads_status_check
  check (status in ('active','unsubscribed','bounced','invalid','blocked'));

-- ───────────────────────── sequence confirmation ─────────────────────────

-- AI writing waits until the user has saved the sequence. Campaigns that already exist count as
-- confirmed, so the backfill runs only when the column is first created (not on a re-run).
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = current_schema() and table_name = 'campaigns' and column_name = 'sequence_confirmed_at'
  ) then
    alter table campaigns add column sequence_confirmed_at timestamptz;
    update campaigns set sequence_confirmed_at = now();
  end if;
end $$;

-- Same as 0003, plus: only campaigns whose sequence has been saved.
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
      and c.sequence_confirmed_at is not null
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

-- ───────────────────────── indexes for the counts below ─────────────────────────

create index if not exists replies_open_idx on replies (handled, kind, received_at desc);
create index if not exists leads_unchecked_idx on leads (created_at desc) where verify_status is null;

-- ───────────────────────── fast counts (one round trip each) ─────────────────────────

-- Everything the Home page needs to decide what to show.
create or replace function home_summary(p_tz text)
returns jsonb
language sql stable
as $$
  select jsonb_build_object(
    -- Inbox "To do": replies that need an answer plus reminders that are due.
    'todo', (select count(*) from replies r
              where r.handled = false and (r.follow_up_at <= now() or (r.kind = 'reply' and r.follow_up_at is null))),
    'reminders_due', (select count(*) from replies r where r.handled = false and r.follow_up_at <= now()),
    'leads', (select count(*) from leads),
    'unchecked', (select count(*) from leads where verify_status is null),
    'launched', (select count(*) from campaigns where status <> 'draft'),
    'campaigns', (select count(*) from campaigns),
    'active_campaigns', (select count(*) from campaigns where status = 'active'),
    'sent_today', (select count(*) from messages m
                    where m.kind = 'campaign' and m.status <> 'failed'
                      and m.sent_at >= (date_trunc('day', now() at time zone p_tz) at time zone p_tz)),
    -- AI drafts for leads that haven't had their first email yet, by prep_status.
    'prep', coalesce((
      select jsonb_object_agg(t.prep_status, t.n)
      from (select prep_status, count(*) as n from campaign_leads
            where status in ('queued','in_progress') and current_step = 0
            group by prep_status) t
    ), '{}'::jsonb),
    'review_by_campaign', coalesce((
      select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'n', t.n) order by t.n desc)
      from (select c.id, c.name, count(*) as n from campaign_leads cl join campaigns c on c.id = cl.campaign_id
            where cl.prep_status = 'review' and cl.status = 'queued'
            group by c.id, c.name) t
    ), '[]'::jsonb),
    'failed_by_campaign', coalesce((
      select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'n', t.n) order by t.n desc)
      from (select c.id, c.name, count(*) as n from campaign_leads cl join campaigns c on c.id = cl.campaign_id
            where cl.prep_status = 'failed' and cl.status = 'queued'
            group by c.id, c.name) t
    ), '[]'::jsonb),
    -- Newest draft campaign (null when there is none).
    'draft', (
      select jsonb_build_object('id', c.id, 'name', c.name,
        'leads', (select count(*) from campaign_leads cl where cl.campaign_id = c.id))
      from campaigns c where c.status = 'draft'
      order by c.created_at desc limit 1
    ),
    'error_accounts', (select count(*) from mailboxes where status = 'error')
  );
$$;

-- Counts for every Inbox view and label.
create or replace function inbox_counts()
returns jsonb
language sql stable
as $$
  select jsonb_build_object(
    'todo', count(*) filter (where handled = false and (follow_up_at <= now() or (kind = 'reply' and follow_up_at is null))),
    'reminders_due', count(*) filter (where handled = false and follow_up_at <= now()),
    'reminders', count(*) filter (where handled = false and follow_up_at > now()),
    'done', count(*) filter (where kind = 'reply' and handled),
    'auto', count(*) filter (where kind in ('auto_reply','bounce')),
    'all', count(*),
    'unread', count(*) filter (where is_read = false and handled = false and kind = 'reply'),
    'labels', coalesce((
      select jsonb_object_agg(t.sentiment, t.n)
      from (select sentiment, count(*) as n from replies
            where kind = 'reply' and sentiment is not null and sentiment <> 'neutral'
            group by sentiment) t
    ), '{}'::jsonb)
  )
  from replies;
$$;

-- Extra columns for the Campaigns list. Interested/meetings count leads, not reply emails.
create or replace function campaign_list_extras(p_tz text)
returns table (campaign_id uuid, sent_today bigint, interested bigint, meetings bigint)
language sql stable
as $$
  select c.id,
    (select count(*) from messages m
      where m.campaign_id = c.id and m.kind = 'campaign' and m.status <> 'failed'
        and m.sent_at >= (date_trunc('day', now() at time zone p_tz) at time zone p_tz)),
    (select count(distinct coalesce(r.lead_id::text, lower(r.from_email))) from replies r
      where r.campaign_id = c.id and r.sentiment = 'interested'),
    (select count(distinct coalesce(r.lead_id::text, lower(r.from_email))) from replies r
      where r.campaign_id = c.id and r.sentiment = 'meeting_booked')
  from campaigns c;
$$;

-- Per-email results for a campaign. A lead that replied after email N counts as a reply to email N
-- (current_step = number of emails sent, and step numbers start at 1).
create or replace function campaign_step_stats(p_campaign uuid, p_since timestamptz default null)
returns table (step_number int, sent bigint, bounced bigint, opened bigint, replied bigint)
language sql stable
as $$
  with sends as (
    select m.step_number as step,
      count(*) filter (where m.status <> 'failed') as sent,
      count(*) filter (where m.status = 'bounced') as bounced,
      count(*) filter (where m.opened_at is not null) as opened
    from messages m
    where m.campaign_id = p_campaign and m.kind = 'campaign' and (p_since is null or m.sent_at >= p_since)
    group by m.step_number
  ), replies_by_step as (
    select cl.current_step as step, count(*) as replied
    from campaign_leads cl
    where cl.campaign_id = p_campaign and cl.status = 'replied'
    group by cl.current_step
  )
  select coalesce(s.step, r.step)::int, coalesce(s.sent, 0), coalesce(s.bounced, 0), coalesce(s.opened, 0), coalesce(r.replied, 0)
  from sends s
  full join replies_by_step r on r.step = s.step
  order by 1;
$$;

-- daily_activity for one campaign (its own emails and the replies to them).
create or replace function campaign_daily_activity(p_campaign uuid, p_days int, p_tz text)
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
    (select count(*) from messages m where m.campaign_id = p_campaign and m.kind = 'campaign' and m.status <> 'failed'
       and (m.sent_at at time zone p_tz)::date = d.day),
    (select count(*) from messages m where m.campaign_id = p_campaign and m.kind = 'campaign' and m.opened_at is not null
       and (m.opened_at at time zone p_tz)::date = d.day),
    (select count(*) from replies r where r.campaign_id = p_campaign and r.kind = 'reply'
       and (r.received_at at time zone p_tz)::date = d.day),
    (select count(*) from messages m where m.campaign_id = p_campaign and m.kind = 'campaign' and m.status = 'bounced'
       and (m.sent_at at time zone p_tz)::date = d.day)
  from days d
  order by d.day;
$$;

-- What enroll_leads would do with the same selection, without doing it ("42 will be added, 3 skipped…").
create or replace function count_enrollable(p_campaign uuid, p_tag text, p_lead_ids uuid[] default null)
returns jsonb
language sql stable
as $$
  with pool as (
    select l.status, l.verify_status,
      exists (select 1 from campaign_leads cl where cl.campaign_id = p_campaign and cl.lead_id = l.id) as already_in,
      exists (select 1 from suppressions s where s.email = l.email) as blocked,
      exists (
        select 1 from campaign_leads cl
        join campaigns c on c.id = cl.campaign_id and c.status = 'active'
        where cl.lead_id = l.id and cl.campaign_id <> p_campaign and cl.status in ('queued','in_progress')
      ) as in_other_active
    from leads l
    -- Same selection as enroll_leads.
    where (p_lead_ids is not null and l.id = any(p_lead_ids)
           or p_lead_ids is null and (p_tag is null or p_tag = any(l.tags)))
  )
  select jsonb_build_object(
    'total', count(*),
    'already_in', count(*) filter (where already_in),
    'blocked', count(*) filter (where blocked),
    'not_emailable', count(*) filter (where status <> 'active'),
    'invalid', count(*) filter (where verify_status = 'invalid'),
    'in_other_active', count(*) filter (where in_other_active),
    'will_add', count(*) filter (where status = 'active' and coalesce(verify_status, 'unknown') <> 'invalid'
                                   and not blocked and not already_in)
  )
  from pool;
$$;

-- Functions are only callable by the service role.
revoke execute on function claim_prep(int) from public, anon, authenticated;
revoke execute on function home_summary(text) from public, anon, authenticated;
revoke execute on function inbox_counts() from public, anon, authenticated;
revoke execute on function campaign_list_extras(text) from public, anon, authenticated;
revoke execute on function campaign_step_stats(uuid, timestamptz) from public, anon, authenticated;
revoke execute on function campaign_daily_activity(uuid, int, text) from public, anon, authenticated;
revoke execute on function count_enrollable(uuid, text, uuid[]) from public, anon, authenticated;
grant execute on function claim_prep(int), home_summary(text), inbox_counts(), campaign_list_extras(text),
  campaign_step_stats(uuid, timestamptz), campaign_daily_activity(uuid, int, text), count_enrollable(uuid, text, uuid[]) to service_role;

-- Ask PostgREST to pick up the new columns/functions immediately.
notify pgrst, 'reload schema';
