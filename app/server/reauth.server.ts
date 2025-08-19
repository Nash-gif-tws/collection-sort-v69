// app/server/reauth.server.ts
import { json } from "@remix-run/node";
import { authenticate } from "~/shopify.server";

/** Returns { shop, admin } from the Admin session, or JSON 401 with reauthUrl. */
export async function requireAdminAndShop(request: Request) {
  try {
    const { session, admin } = await authenticate.admin(request);
    return { shop: session.shop, admin };
  } catch {
    const url = new URL(request.url);
    const shop = url.searchParams.get("shop") || "";
    const host = url.searchParams.get("host") || "";
    const qs = [];
    if (shop) qs.push(`shop=${encodeURIComponent(shop)}`);
    if (host) qs.push(`host=${encodeURIComponent(host)}`);
    const reauthUrl = `/auth${qs.length ? `?${qs.join("&")}` : ""}`;
    throw json({ ok: false, error: "reauth", reauthUrl }, { status: 401 });
  }
}

/** Back-compat: only shop string */
export async function requireShopAdmin(request: Request) {
  const { shop } = await requireAdminAndShop(request);
  return shop;
}
