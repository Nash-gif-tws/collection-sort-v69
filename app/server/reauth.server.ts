// app/server/reauth.server.ts
import { json } from "@remix-run/node";
import { authenticate } from "~/shopify.server";

/** Enforce admin session but return JSON 401 (not HTML) when reauth is needed. */
export async function ensureAdminOrJsonReauth(request: Request) {
  try {
    await authenticate.admin(request);
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