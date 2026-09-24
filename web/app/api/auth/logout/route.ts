export const runtime = "nodejs";

import { NextResponse } from "next/server";
import {
  getSessionFromCookie,
  deleteSession,
  SESSION_COOKIE,
} from "@/lib/services/auth.service";
import { revokeResumeTokens } from "@/lib/services/resume-token";

export async function POST() {
  const session = await getSessionFromCookie();
  if (session) {
    deleteSession(session.id);
    revokeResumeTokens(session.username);
  }
  const res = NextResponse.json({ data: { ok: true } });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
