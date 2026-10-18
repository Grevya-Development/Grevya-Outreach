// The AI playbook: how a campaign's emails should be built. Stored per campaign in app_state
// (`playbook:<campaignId>`) on top of a global default (`playbook:default`), so no migration is
// needed and every field is optional.
import { db } from "./supabase";
import { DEFAULT_PLAYBOOK, PILLARS, type Pillar, type Playbook } from "./playbook-shared";

export * from "./playbook-shared";

const KEY = (campaignId: string | null) => (campaignId ? `playbook:${campaignId}` : "playbook:default");

function merge(base: Playbook, over: Partial<Playbook> | null | undefined): Playbook {
  if (!over) return base;
  const out: Playbook = { ...base, ...over, pillar_notes: { ...base.pillar_notes, ...(over.pillar_notes ?? {}) } };
  if (!Array.isArray(out.pillars) || !out.pillars.length) out.pillars = base.pillars;
  out.pillars = out.pillars.filter((p): p is Pillar => PILLARS.includes(p));
  if (!Array.isArray(out.structure) || !out.structure.length) out.structure = base.structure;
  return out;
}

/** Effective playbook for a campaign: built-in defaults ← your default ← this campaign's overrides. */
export async function getPlaybook(campaignId: string | null): Promise<Playbook> {
  const supa = db();
  const keys = campaignId ? [KEY(null), KEY(campaignId)] : [KEY(null)];
  const { data } = await supa.from("app_state").select("key, value").in("key", keys);
  const byKey = new Map((data ?? []).map((r) => [r.key as string, r.value as Partial<Playbook>]));
  return merge(merge(DEFAULT_PLAYBOOK, byKey.get(KEY(null))), campaignId ? byKey.get(KEY(campaignId)) : null);
}

/** Saves a playbook for one campaign, or (campaignId = null) as the default for new campaigns. */
export async function savePlaybook(campaignId: string | null, pb: Partial<Playbook>): Promise<void> {
  const clean = merge(DEFAULT_PLAYBOOK, pb);
  const { error } = await db().from("app_state").upsert({ key: KEY(campaignId), value: clean, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
}
