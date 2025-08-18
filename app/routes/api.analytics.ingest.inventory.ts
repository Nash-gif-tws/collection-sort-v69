// app/routes/api.analytics.ingest.inventory.ts
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { ensureAdminOrJsonReauth } from "~/server/reauth.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await ensureAdminOrJsonReauth(request);
  // For now just acknowledge. Later wire to real Shopify inventory fetch + prisma writes.
  return json({ ok: true, snapshots: 0, variants: 0 });
}
