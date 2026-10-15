import type { NextRequest, NextResponse } from "next/server";

import { IMPERSONATE_COOKIE_NAME_EDGE, verifyImpersonateCookieEdge } from "./cookie-edge";

export async function validarCookieDeAcompanhamento(
  request: NextRequest,
  response: NextResponse,
  pathname: string,
): Promise<void> {
  if (!pathname.startsWith("/app")) return;

  const token = request.cookies.get(IMPERSONATE_COOKIE_NAME_EDGE)?.value;
  if (!token) return;

  const result = await verifyImpersonateCookieEdge(
    token,
    process.env.IMPERSONATE_COOKIE_SECRET ?? "",
  );
  if (!result.valid) {
    console.warn(
      `[middleware] impersonate cookie invalid (${result.reason ?? "unknown"}) — clearing`,
    );
    response.cookies.delete(IMPERSONATE_COOKIE_NAME_EDGE);
  }
}
