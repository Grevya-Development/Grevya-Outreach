import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "./env";

function key(): Buffer {
  const k = Buffer.from(env.encryptionKey, "base64");
  if (k.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)");
  return k;
}

/** AES-256-GCM. Output: iv.tag.ciphertext (base64url). */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString("base64url")).join(".");
}

export function decrypt(payload: string): string {
  const [iv, tag, enc] = payload.split(".").map((p) => Buffer.from(p, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

export function sign(value: string): string {
  return createHmac("sha256", env.appSecret).update(value).digest("base64url").slice(0, 22);
}

export function verifySig(value: string, sig: string): boolean {
  const expected = Buffer.from(sign(value));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Token for unsubscribe links: "<leadId>.<campaignId|_>.<sig>". */
export function unsubscribeToken(leadId: string, campaignId: string | null): string {
  const body = `${leadId}.${campaignId ?? "_"}`;
  return `${body}.${sign(`unsub:${body}`)}`;
}

export function parseUnsubscribeToken(token: string): { leadId: string; campaignId: string | null } | null {
  const [leadId, campaignId, sig] = token.split(".");
  if (!leadId || !campaignId || !sig) return null;
  if (!verifySig(`unsub:${leadId}.${campaignId}`, sig)) return null;
  return { leadId, campaignId: campaignId === "_" ? null : campaignId };
}
