// app/routes/api.products.search.ts
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { requireAdminAndShop } from "~/server/reauth.server";

/**
 * GET /api/products.search?q=term&first=10
 * Returns lightweight items for the bundle component picker.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  // Ensure we have an Admin API client (and session)
  try {
    const { admin } = await requireAdminAndShop(request);

    const url = new URL(request.url);
    const qRaw = (url.searchParams.get("q") || "").trim();
    const first = Math.min(
      Math.max(parseInt(url.searchParams.get("first") || "10", 10) || 10, 1),
      25
    );

    if (!qRaw) return json({ ok: true, items: [] });

    // Broaden search: title, sku, vendor (wildcards supported)
    const query = `title:*${qRaw}* OR sku:*${qRaw}* OR vendor:*${qRaw}*`;

    const resp = await admin.graphql(
      `#graphql
      query ProductSearch($query: String!, $first: Int!) {
        products(first: $first, query: $query) {
          edges {
            node {
              id
              title
              vendor
              variants(first: 50) {
                edges {
                  node {
                    id
                    title
                    sku
                    selectedOptions { name value }
                  }
                }
              }
            }
          }
        }
      }`,
      { variables: { query, first } }
    );

    const payload = await resp.json();

    // If Shopify responds with GraphQL errors, surface them cleanly
    if (payload?.errors?.length) {
      const msg =
        payload.errors.map((e: any) => e.message).join("; ") || "GraphQL error";
      return json({ ok: false, error: msg }, { status: 200 });
    }

    const items =
      payload?.data?.products?.edges?.flatMap((e: any) => {
        const p = e.node;
        return (
          p?.variants?.edges?.map((ve: any) => {
            const v = ve.node;
            const opt =
              v?.selectedOptions
                ?.map((o: any) => `${o.name}:${o.value}`)
                .join(" / ") || v?.title || "";
            return {
              id: v.id, // variant gid
              productId: p.id,
              productTitle: p.title,
              vendor: p.vendor,
              sku: v.sku || "",
              options: v.selectedOptions || [],
              label: [p.title, opt].filter(Boolean).join(" — "),
            };
          }) || []
        );
      }) || [];

    return json({ ok: true, items });
  } catch (err: any) {
    // If our auth guard wants a reauth, return 401+JSON so the client can bounce top-level
    if (err?.reauthUrl) {
      return json({ ok: false, reauthUrl: err.reauthUrl }, { status: 401 });
    }
    return json(
      { ok: false, error: err?.message || String(err) },
      { status: 200 }
    );
  }
}
