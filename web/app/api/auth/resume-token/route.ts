export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { isAuthed } from "@/lib/api-auth";
import { unauthorized } from "@/lib/bff";
import { getSessionFromCookie } from "@/lib/services/auth.service";
import { issueResumeToken } from "@/lib/services/resume-token";

/** 已登录的原生壳领一枚续期凭证（见 lib/services/resume-token.ts），到期时间跟当前会话走 */
export async function POST(request: Request) {
  const session = (await isAuthed(request)) ? await getSessionFromCookie() : undefined;
  if (!session) return unauthorized();
  return NextResponse.json({ token: issueResumeToken(session.username, session.expires_at) });
}
