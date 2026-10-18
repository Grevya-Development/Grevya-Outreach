import { EMPTY_PROFILE, type CompanyProfile } from "./research";
import { db } from "./supabase";

export async function getProfile(): Promise<CompanyProfile> {
  const { data } = await db().from("app_state").select("value").eq("key", "company_profile").maybeSingle();
  return { ...EMPTY_PROFILE, ...((data?.value as Partial<CompanyProfile>) ?? {}) };
}

export async function setProfile(p: CompanyProfile) {
  const { error } = await db().from("app_state").upsert({ key: "company_profile", value: p, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
}
