// app/server/reauth.server.ts
import { authenticate } from "~/shopify.server";

/**
 * Returns {admin, shop} when session is valid.
 * If auth is required, returns {reauth: true, reauthUrl} with NO thrown redirect.
 */
export async function ensureAdminOrJsonReauth(request: Request): Promise<
  | { admin: any; shop: string; reauth: false }
  | { admin: null; shop: string; reauth: true; reauthUrl: string }
> {
  try {
    const { admin, session } = await authenticate.admin(request);
    return { admin, shop: session.shop, reauth: false };
  } catch (err: unknown) {
    // Build a top-level auth URL that works both inside/outside the iframe
    const u = new URL(request.url);
    const shop = u.searchParams.get("shop") || "";
    const host = u.searchParams.get("host") || "";
    const qs = new URLSearchParams();
    if (shop) qs.set("shop", shop);
    if (host) qs.set("host", host);
    const reauthUrl = `/auth${qs.toString() ? `?${qs}` : ""}`;
    return { admin: null, shop, reauth: true, reauthUrl };
  }
}

/** Old helper some routes may import */
export async function requireAdminAndShop(request: Request) {
  const res = await ensureAdminOrJsonReauth(request);
  if ("reauth" in res && res.reauth) {
    // Keep previous behavior for old routes: throw a 401 JSON
    throw new Response(JSON.stringify({ ok: false, reauthUrl: res.reauthUrl }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  return res;
}
