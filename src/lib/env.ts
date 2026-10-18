function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}. Copy .env.example to .env.local and fill it in.`);
  return v;
}

export const env = {
  get supabaseUrl() { return required("SUPABASE_URL"); },
  get supabaseServiceKey() { return required("SUPABASE_SERVICE_ROLE_KEY"); },
  get groqKey() { return process.env.GROQ_API_KEY ?? ""; },
  get groqModel() { return process.env.GROQ_MODEL || "openai/gpt-oss-120b"; },
  /** Small, fast model for reply classification. */
  get groqFastModel() { return process.env.GROQ_FAST_MODEL || "openai/gpt-oss-20b"; },
  get appPassword() { return required("APP_PASSWORD"); },
  get appSecret() { return required("APP_SECRET"); },
  get encryptionKey() { return required("ENCRYPTION_KEY"); },
  get appUrl() { return (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, ""); },
  get cronSecret() { return process.env.CRON_SECRET ?? ""; },
  get timezone() { return process.env.APP_TIMEZONE || "Asia/Kolkata"; },
};

