// Builds the exact subject + body a lead receives for a step. Used by the engine and by
// the campaign preview so what you see is what gets sent.
import { unsubscribeToken } from "./crypto";
import { env } from "./env";
import { isPublicUrl } from "./schedule";
import { render, usesVariable } from "./template";
import type { Campaign, CampaignLead, CampaignStep, Lead, Mailbox } from "./types";

export const OPT_OUT_LINE = "Not the right person, or not interested? Just reply \"no\" and I won't email again.";

export interface Composed {
  subject: string;
  text: string;
  unsubscribeUrl: string | null;     // shown in body only if the template asks for it
  oneClickUnsubscribeUrl: string | null; // List-Unsubscribe header (needs a public APP_URL)
}

export class NotPreparedError extends Error {}

export function composeEmail(args: {
  campaign: Pick<Campaign, "id" | "mode" | "include_unsubscribe">;
  steps: Pick<CampaignStep, "subject" | "body" | "step_number">[];
  stepIndex: number;
  cl: Pick<CampaignLead, "id" | "personalization" | "last_subject" | "last_message_id">;
  lead: Lead;
  mailbox: Pick<Mailbox, "from_name" | "signature">;
  address?: string;
}): Composed {
  const { campaign, steps, stepIndex, cl, lead, mailbox } = args;
  const step = steps[stepIndex];
  const isFollowUp = stepIndex > 0;
  const publicApp = isPublicUrl(env.appUrl);
  const token = unsubscribeToken(lead.id, campaign.id);
  const unsubscribeUrl = publicApp ? `${env.appUrl}/u/${token}` : null;
  const ctx = {
    lead,
    aiLine: cl.personalization?.ai_line,
    senderName: mailbox.from_name,
    signature: mailbox.signature,
    unsubscribeUrl: unsubscribeUrl ?? "",
    seed: `${cl.id}:${step.step_number}`,
  };

  let subject: string;
  let body: string;
  if (campaign.mode === "ai") {
    const written = cl.personalization?.emails?.[stepIndex];
    if (!written) throw new NotPreparedError("AI email not written yet for this step");
    subject = written.subject;
    body = written.body;
  } else {
    subject = render(step.subject, ctx);
    body = render(step.body, ctx);
  }

  const firstSubject = cl.last_subject
    || (campaign.mode === "ai" ? cl.personalization?.emails?.[0]?.subject : render(steps[0]?.subject ?? "", { ...ctx, seed: `${cl.id}:${steps[0]?.step_number ?? 1}` }))
    || "";
  // "Re:" only when it really continues a thread we started from this mailbox.
  const threaded = isFollowUp && Boolean(cl.last_message_id);
  if (isFollowUp && !subject) subject = threaded ? (firstSubject.startsWith("Re:") ? firstSubject : `Re: ${firstSubject}`) : firstSubject;
  if (!subject) subject = firstSubject || "Quick question";

  // Signature: the mailbox signature, or the sender's first name for AI emails (which are written without one).
  const usesSig = campaign.mode === "template" && usesVariable(step.body, "signature");
  if (!usesSig) {
    const sig = mailbox.signature ? render(mailbox.signature, ctx) : campaign.mode === "ai" ? (mailbox.from_name.split(" ")[0] ?? "") : "";
    if (sig) body += `\n\n${sig}`;
  }
  if (args.address && !body.includes(args.address)) body += `\n${args.address}`;

  // Opt-out: a plain-text line (no link — links in cold email hurt inbox placement) plus the
  // List-Unsubscribe header that Gmail/Yahoo show as an "Unsubscribe" button.
  if (campaign.include_unsubscribe && !(campaign.mode === "template" && usesVariable(step.body, "unsubscribe_url"))) {
    body += `\n\n${OPT_OUT_LINE}`;
  }

  return {
    subject,
    text: body.trim(),
    unsubscribeUrl,
    oneClickUnsubscribeUrl: campaign.include_unsubscribe && publicApp ? `${env.appUrl}/api/unsubscribe/${token}` : null,
  };
}
