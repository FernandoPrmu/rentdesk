import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

import {
  authenticatedAtFromClaims,
  blockReason,
  GUARD_REDIRECT_HEADER,
  isPublicPath,
  isServerActionRequest,
  LAST_SEEN_COOKIE,
  LAST_SEEN_REFRESH_MS,
  lastSeenCookieOptions,
  LOGIN_PATH,
  parseLastSeen,
  routeDecision,
  type SessionState,
  sessionTimeout,
  type SignOutReason,
} from "@/lib/auth/session-policy";
import { publicEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/types/db";

/**
 * Route guard (Next 16 proxy). For every page request:
 *   1. refresh the Supabase session cookies;
 *   2. signed out: only public pages, otherwise /login?next=...;
 *   3. blocked (suspended, deactivated, customer of an inactive owner) or timed out
 *      (idle / maximum session length): sign out and explain on /login (AUTH-09/10);
 *   4. forced password change, then owner setup, then role portals (AUTH-03/06, BRD-01).
 * Pages and Server Actions check again through src/lib/auth/current-user.ts.
 *
 * Server Action requests (POST + Next-Action) never get a redirect or an error page
 * from here: React's action client accepts only an action response. They pass
 * through (after any forced sign-out, so the action sees no session) with the
 * target page in GUARD_REDIRECT_HEADER; currentActor() then redirects properly.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const env = publicEnv();

  const supabase = createServerClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
        for (const [key, value] of Object.entries(headers ?? {})) response.headers.set(key, value);
      },
    },
  });

  const { pathname, search } = request.nextUrl;
  const isAction = isServerActionRequest(request.method, request.headers);
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  // Keep any cookies written above (refreshed or cleared session) on the new response.
  const withSessionCookies = (target: NextResponse) => {
    for (const cookie of response.cookies.getAll()) target.cookies.set(cookie);
    // Auth cookie writes come with no-store headers; a response that sets cookies must not be cached either.
    for (const key of ["cache-control", "expires", "pragma"]) {
      const value = response.headers.get(key);
      if (value) target.headers.set(key, value);
    }
    return target;
  };

  // Server Action: pass through to the action, telling it where the user must go
  // (null = allowed). A client-sent header of the same name is always dropped.
  const forwardAction = (path: string | null) => {
    const headers = new Headers(request.headers);
    headers.delete(GUARD_REDIRECT_HEADER);
    if (path) headers.set(GUARD_REDIRECT_HEADER, path);
    return withSessionCookies(NextResponse.next({ request: { headers } }));
  };

  const redirectTo = (path: string) =>
    isAction ? forwardAction(path) : withSessionCookies(NextResponse.redirect(new URL(path, request.url)));
  const allow = () => (isAction ? forwardAction(null) : response);

  if (!claims?.sub) {
    if (isPublicPath(pathname)) return allow();
    return redirectTo(`${LOGIN_PATH}?next=${encodeURIComponent(pathname + search)}`);
  }

  const { data: stateData, error } = await loadState(claims.sub);
  if (error) {
    console.error("[proxy] session state:", error.message);
    // An action checks the session again itself and reports a failure in its own response.
    if (isAction) return forwardAction(null);
    return new NextResponse("Service unavailable. Please try again in a moment.", { status: 503 });
  }
  const state = (stateData as SessionState | null) ?? null;
  const now = new Date();

  const signOut = async (reason: SignOutReason) => {
    await supabase.auth.signOut({ scope: "local" });
    response.cookies.delete(LAST_SEEN_COOKIE);
    return redirectTo(`${LOGIN_PATH}?reason=${reason}`);
  };

  const blocked = blockReason(state);
  if (blocked || !state) return signOut(blocked ?? "no_profile");

  const lastSeenAt = parseLastSeen(request.cookies.get(LAST_SEEN_COOKIE)?.value);
  const timeout = sessionTimeout({
    now,
    authenticatedAt: authenticatedAtFromClaims(claims),
    lastSeenAt,
    idleMinutes: state.session_idle_minutes,
    maxHours: state.session_max_hours,
  });
  if (timeout) return signOut(timeout);

  if (!lastSeenAt || now.getTime() - lastSeenAt.getTime() > LAST_SEEN_REFRESH_MS) {
    response.cookies.set(LAST_SEEN_COOKIE, String(now.getTime()), lastSeenCookieOptions());
  }

  const target = routeDecision(state, pathname);
  return target ? redirectTo(target) : allow();
}

/** Account state, retried once when the network to Supabase drops a request. */
async function loadState(userId: string) {
  const admin = createAdminClient();
  const first = await admin.rpc("rpc_session_state", { p_user_id: userId });
  if (!first.error || !/fetch failed|network/i.test(first.error.message)) return first;
  return admin.rpc("rpc_session_state", { p_user_id: userId });
}

export const config = {
  matcher: [
    {
      // Everything except Next internals, API routes (cron has its own secret),
      // the service worker, the manifest and static files.
      source:
        "/((?!_next/|api/|sw\\.js|swe-worker|manifest\\.webmanifest|favicon\\.ico|icon|apple-icon|.*\\.(?:png|jpg|jpeg|svg|webp|ico|txt|js|map)$).*)",
      // Router prefetches (production builds prefetch every visible link) skip the
      // guard: a redirect answer is logged in the browser as a failed load. They carry
      // only the static shell (partial prefetching), every page checks the user again
      // (requireUser), and the real navigation comes through here.
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
