-- Dashboard bounce count: count bounced messages (SMTP rejections + IMAP bounce reports).
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
