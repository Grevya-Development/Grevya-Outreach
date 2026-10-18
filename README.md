# Grevya Outreach

Self-hosted cold email: sends personalised sequences from your own mailboxes (info@grevya.com on GoDaddy to start), writes a personal opening line per lead with Groq, detects replies and bounces, and stops follow-ups automatically.

**Stack:** Next.js 16 · Supabase (Postgres) · Groq · Nodemailer (SMTP) · ImapFlow (IMAP)

## What it does

- **AI-researched emails (default):** for every lead the engine:
  - reads the company website (with a JavaScript-rendering fallback), and detects their tech (Shopify, HubSpot, Meta Pixel and so on)
  - scores fit from 0 to 10 against your company profile and skips poor fits
  - picks the Grevya service that fits best, then writes the whole sequence

  Every draft passes quality gates before it can send: no links, no placeholders, a spam-word check, and no number that isn't in your proof list or their website.
- **Company profile:** in Settings → Company profile, use "Import from website" to draft it from grevya.com. The AI only quotes the results you list there.
- **Add people however you like:** type one person in, paste a list (plain emails, `Name <email>`, or spreadsheet rows), or import a CSV — straight into a campaign if you want.
- **Follow-up made easy (Inbox):** "Needs reply" and "Follow-ups due" queues, the full conversation thread, reply in the same thread from the app with an AI-suggested draft, one-click reminders (tomorrow / 3 days / next week), private notes, and a "New email" button for one-off messages. Everything sent is copied to the mailbox's Sent folder so your normal email app shows the whole conversation.
- **Email checks:** every new lead's address is checked automatically in the background while the app runs (newest first, up to 25 at a time). Invalid addresses are marked and never emailed. To check a list by hand or find someone's email, use Leads → Find & verify:
  - **Checks:** syntax and typos (gmial.com → gmail.com), mail server, disposable and role addresses, and whether the mailbox really exists (asked of the company's mail server over SMTP; nothing is sent). Accept-all domains are detected.
  - **Find someone's email:** from first name, last name and company domain, it builds the likely formats and learns the company's pattern from your existing leads and its website, then confirms with the mail server.
  - **Saving:** results go straight to Leads or a campaign.
  - **Port 25 required:** mailbox checks need outgoing port 25. Many networks and clouds block it; the app detects this and falls back gracefully.
- **Template mode:** `{{variables}}`, `{Hi|Hey}` spintax and an optional one-line AI opener.
- **Mailboxes:** any SMTP/IMAP inbox; GoDaddy is auto-detected from MX.
  - **Caps:** each mailbox is hard-capped at 400/day, enforced atomically in Postgres.
  - **Pacing:** the daily quota is spread evenly over your sending hours with random gaps.
  - **Warm-up:** an automatic ramp, with a "full capacity on <date>" estimate.
  - **Domain health:** a SPF/DKIM/DMARC/MX check per mailbox.
- **Safety:**
  - **Duplicates:** a (lead, step) is reserved before SMTP, so no duplicate sends even after a crash.
  - **Mailbox protection:** quota and policy errors never count as bounces, and a mailbox auto-pauses at 5 bounces in a row or more than 5% bounces.
  - **Lead spacing:** one new conversation per company per day, and no re-contact within 7 days across campaigns.
  - **Reply checks:** the inbox is re-checked right before every follow-up.
- **Inbox:**
  - **Reply matching:** replies are matched by sender and by thread (In-Reply-To).
  - **Classification:** auto-replies are ignored, delay notices aren't counted as bounces, and replies are classified as interested, not interested or neutral.
  - **Opt-outs:** "no", "unsubscribe" or "remove me" (in the subject or the body) puts the address on the block list permanently.
- **Compliance:** a plain-text opt-out line (no link), `List-Unsubscribe` headers, and an optional company address footer.

## Reaching 800 emails/day without the spam folder

- **800/day needs at least 2 mailboxes at 400.** Use a second domain (e.g. `getgrevya.com`) so a reputation hit can't affect info@grevya.com.
- **Warm-up takes time.** At the default 20 → +10/day, each mailbox reaches 400/day in about 5 weeks. Rushing this is the most common way to land in spam.
- **Turn on DKIM** (Mailboxes → deliverability panel). Without it Gmail and Outlook distrust you.
- **Keep bounces under 2%:** new leads are checked automatically before they're emailed. The engine also auto-pauses bad mailboxes.
- **Groq:** the free plan allows ~1,000 requests and 200K tokens per model per day. A researched lead uses ~5,500 tokens, so free covers roughly 150–250 researched leads a day (the engine rotates across 3 models). For 800/day, enable Groq's pay-as-you-go plan — about $1/day.
- **No tool can guarantee inbox placement.** Relevance (research), low volume per mailbox, authentication and clean lists are what move it.

## Setup (about 10 minutes)

Requires **Node 20+**.

1. **Supabase:** create a free project at supabase.com.
2. **Env:** open `.env.local`. The secrets are already generated. Fill in:
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (Project Settings → API)
   - `DATABASE_URL` (Project Settings → Database → Connection string → Session pooler), used only by the next step
   - `GROQ_API_KEY` (console.groq.com/keys)
   - `APP_PASSWORD`: your dashboard password
3. **Create tables:**
   ```bash
   npm run db:setup
   ```
   Or paste each file in `supabase/migrations/` (0001, 0002, 0003 …) into the Supabase SQL editor, in order. The app shows a banner — and the engine refuses to send — until the database is up to date.
4. **Run the app:**
   ```bash
   npm run dev
   ```
   This also starts the sending engine (you'll see one `[engine] started` line). It sends due emails, checks inboxes for replies, writes AI emails ahead of time and checks new leads' addresses, for as long as the app runs. Pause and resume all sending with the switch at the bottom of the sidebar. If you run the app on another port (e.g. `next dev -p 3001`), set `APP_URL` to match.

Then:
1. Email accounts → add info@grevya.com (GoDaddy preset) → Test connection → Send test email to your Gmail.
2. Leads → Import CSV with a tag.
3. Campaigns → New → edit the sequence → Settings (your offer for the AI) → Leads tab: add the tag → Launch.

## Running it 24/7

The engine has to keep running during sending hours. Pick one:

- **App server (simplest):** `npm run build && npm start` on any always-on machine (a small VPS, Railway, Render, or your laptop while it's awake). The engine starts with the app, just like `npm run dev`.
- **Separate worker (optional):** to send from a different machine than the dashboard, run `npm run worker` there and set `ENGINE_IN_APP=off` on the web app so only one machine sends.
- **Serverless (e.g. Vercel):** the in-app engine doesn't run there. Have a free cron (cron-job.org) call `GET https://your-domain/api/engine/tick` every minute with the header `Authorization: Bearer $CRON_SECRET`.

Set `APP_URL` to the public URL once deployed. Unsubscribe links (and open/click tracking, if enabled) point there.

## Deliverability checklist for grevya.com

- SPF ✅ and DMARC ✅ are already published. **Turn on DKIM** in GoDaddy email settings; it wasn't found under common selectors.
- Keep warm-up on. Sending 400/day from a new or cold mailbox on day 1 will land in spam.
- Keep bounces under 2–3%: let the background email checks finish before launching a campaign on a new import.
- Plain text, no images, 0–1 links, and a real `{{ai_line}}`.
- Sending cold email from your main domain risks normal mail going to spam. To scale past 400/day, add mailboxes on a secondary domain (e.g. `getgrevya.com`) and attach them to the same campaign. The engine rotates automatically.
