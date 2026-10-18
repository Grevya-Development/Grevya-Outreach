// Parses pasted contacts in whatever shape people paste them. Pure (client + server).
//   priya@acme.com
//   Priya Sharma <priya@acme.com>
//   Priya Sharma, priya@acme.com, Acme Corp, Head of Ops
//   priya@acme.com	Priya	Sharma	Acme        (tab-separated, e.g. from a spreadsheet)

export interface ParsedLead {
  email: string;
  first_name: string;
  last_name: string;
  company: string;
  title: string;
}

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/i;

function splitName(name: string): { first_name: string; last_name: string } {
  const parts = name.replace(/["']/g, "").trim().split(/\s+/).filter(Boolean);
  return { first_name: parts[0] ?? "", last_name: parts.slice(1).join(" ") };
}

/** Guesses a company name from a business email domain (acme-tech.co.in → Acme Tech). */
export function companyFromEmail(email: string): string {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  if (/^(gmail|googlemail|yahoo|outlook|hotmail|live|icloud|me|aol|proton|protonmail|rediffmail|zoho|gmx|yandex|mail)\./.test(domain)) return "";
  const base = domain.split(".")[0] ?? "";
  return base.split(/[-_]/).map((w) => (w ? w[0].toUpperCase() + w.slice(1) : "")).join(" ");
}

export function parseLeads(text: string): { leads: ParsedLead[]; invalid: string[] } {
  const leads = new Map<string, ParsedLead>();
  const invalid: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(EMAIL);
    if (!m) { invalid.push(line); continue; }
    const email = m[0].toLowerCase();
    let name = { first_name: "", last_name: "" };
    let company = "";
    let title = "";
    const angle = line.match(/^(.*?)<\s*[^<>]+@[^<>]+>/);
    if (angle) {
      // "Name <email>" — everything before the bracket is the name (commas allowed in quotes).
      name = splitName(angle[1].replace(/,/g, " "));
    } else {
      const delim = line.includes("\t") ? "\t" : line.includes(",") ? "," : line.includes(";") ? ";" : line.includes("|") ? "|" : null;
      const cells = delim ? line.split(delim).map((c) => c.trim()) : [line];
      const at = cells.findIndex((c) => EMAIL.test(c));
      const before = cells.slice(0, at).filter(Boolean);
      const after = cells.slice(at + 1).filter(Boolean);
      if (before.length) {
        // Name, email, Company, Title
        name = splitName(before.join(" "));
        [company = "", title = ""] = after;
      } else if (after.length) {
        // email, First, Last, Company, Title (spreadsheet order)
        name = { first_name: after[0] ?? "", last_name: after[1] ?? "" };
        [company = "", title = ""] = after.slice(2);
      }
    }
    leads.set(email, { email, ...name, company: company || companyFromEmail(email), title });
  }
  return { leads: [...leads.values()], invalid };
}
