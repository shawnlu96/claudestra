export const runtime = "nodejs";

import { NextResponse } from "next/server";
import {
  getSessionFromCookie,
  deleteSession,
  SESSION_COOKIE,
} from "@/lib/services/auth.service";

export async function POST() {
  const session = await getSessionFromCookie();
  if (session) {
    deleteSession(session.id);
  }
  const res = NextResponse.json({ data: { ok: true } });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
