// app/routes/api.features.ts
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { requireAdminAndShop } from "~/server/reauth.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireAdminAndShop(request);

  // Force-enable for testing. We can add real detection later.
  return json(
    {
      ok: true,
      features: {
        bundles: true,
        combinedListings: true, // Joined Listing tab enabled
      },
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
}
