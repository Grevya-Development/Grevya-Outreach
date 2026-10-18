import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "go_session";
const MAX_AGE_SEC = 60 * 60 * 24 * 30;

function mac(exp: string): string {
  return createHmac("sha256", process.env.APP_SECRET ?? "").update(`session:${exp}`).digest("base64url");
}

export function createSession(): { value: string; maxAge: number } {
  const exp = String(Math.floor(Date.now() / 1000) + MAX_AGE_SEC);
  return { value: `${exp}.${mac(exp)}`, maxAge: MAX_AGE_SEC };
}

export function isValidSession(value: string | undefined): boolean {
  if (!value || !process.env.APP_SECRET) return false;
  const [exp, sig] = value.split(".");
  if (!exp || !sig || Number(exp) * 1000 < Date.now()) return false;
  const a = Buffer.from(mac(exp));
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function checkPassword(input: string): boolean {
  const expected = process.env.APP_PASSWORD ?? "";
  if (!expected) return false;
  const a = Buffer.from(createHmac("sha256", "pw").update(input).digest());
  const b = Buffer.from(createHmac("sha256", "pw").update(expected).digest());
  return timingSafeEqual(a, b);
}
