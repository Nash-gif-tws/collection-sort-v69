// app/server/reauth.server.ts
import { json } from "@remix-run/node";
import { authenticate } from "~/shopify.server";

/**
 * Returns { shop, admin } from the Admin session, or throws JSON 401 with {reauthUrl}
 * so fetchers can redirect to top-level OAuth.
 */
export async function requireAdminAndShop(request: Request) {
  try {
    const { session, admin } = await authenticate.admin(request);
    return { shop: session.shop, admin };
  } catch {
    const url = new URL(request.url);
    const shop = url.searchParams.get("shop") || "";
    const host = url.searchParams.get("host") || "";
    const qs: string[] = [];
    if (shop) qs.push(`shop=${encodeURIComponent(shop)}`);
    if (host) qs.push(`host=${encodeURIComponent(host)}`);
    const reauthUrl = `/auth${qs.length ? `?${qs.join("&")}` : ""}`;
    throw json({ ok: false, error: "reauth", reauthUrl }, { status: 401 });
  }
}

/** Back-compat helper that returns only the shop string. */
export async function requireShopAdmin(request: Request) {
  const { shop } = await requireAdminAndShop(request);
  return shop;
}

/**
 * BACKWARDS COMPAT ALIAS:
 * Some routes import { ensureAdminOrJsonReauth } expecting the same return as requireAdminAndShop.
 * Export it as an alias so those imports keep working without code changes.
 */
export const ensureAdminOrJsonReauth = requireAdminAndShop;
