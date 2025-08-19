// app/routes/api.features.ts
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { ensureAdminOrJsonReauth } from "~/server/reauth.server";

async function respond(request: Request) {
  const res = await ensureAdminOrJsonReauth(request);
  if ("reauth" in res && res.reauth) {
    return json({ ok: false, reauthUrl: res.reauthUrl }, { status: 401 });
  }
  // Force-enable to unblock the UI
  return json(
    { ok: true, features: { bundles: true, combinedListings: true } },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function loader({ request }: LoaderFunctionArgs) {
  return respond(request);
}

export async function action({ request }: ActionFunctionArgs) {
  return respond(request);
}
