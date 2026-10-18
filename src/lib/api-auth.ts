import { cookies } from "next/headers";
import { isValidSession, SESSION_COOKIE } from "./auth";

/**
 * Guard for GET/POST route handlers: returns a 401 response when the visitor isn't signed in,
 * otherwise null. Usage: `const deny = await apiAuth(); if (deny) return deny;`
 */
export async function apiAuth(): Promise<Response | null> {
  if (isValidSession((await cookies()).get(SESSION_COOKIE)?.value)) return null;
  return Response.json({ error: "unauthorized" }, { status: 401 });
}
