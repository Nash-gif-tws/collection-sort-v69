// app/routes/api.products.search.ts
import type {LoaderFunctionArgs} from "@remix-run/node";
import {json} from "@remix-run/node";
import {authenticate} from "~/shopify.server";

/**
 * GET /api/products.search?q=term&first=10
 * Returns lightweight items (variants) for the bundle picker.
 */
export async function loader({request}: LoaderFunctionArgs) {
  // Always return JSON. If auth is missing, respond 401 with { reauthUrl }.
  const url = new URL(request.url);
  const qRaw = (url.searchParams.get("q") || "").trim();
  const first = Math.min(
    Math.max(parseInt(url.searchParams.get("first") || "10", 10) || 10, 1),
    25
  );

  if (!qRaw) return json({ok: true, items: []});

  // Build a product search string (title/sku/vendor)
  const query = `title:*${qRaw}* OR sku:*${qRaw}* OR vendor:*${qRaw}*`;

  // Try to authenticate; if it fails, return JSON that the client can handle.
  let admin: any;
  try {
    const auth = await authenticate.admin(request);
    admin = auth.admin;
  } catch {
    const shop = url.searchParams.get("shop") || "";
    const host = url.searchParams.get("host") || "";
    const qs: string[] = [];
    if (shop) qs.push(`shop=${encodeURIComponent(shop)}`);
    if (host) qs.push(`host=${encodeURIComponent(host)}`);
    const reauthUrl = `/auth${qs.length ? `?${qs.join("&")}` : ""}`;
    return json({ok: false, reauthUrl}, {status: 401});
  }

  try {
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
      {variables: {query, first}}
    );

    const body = await resp.json();

    if (body?.errors?.length) {
      return json(
        {ok: false, error: body.errors[0]?.message || "GraphQL error"},
        {status: 200}
      );
    }

    const items =
      body?.data?.products?.edges?.flatMap((e: any) => {
        const p = e.node;
        return (
          p?.variants?.edges?.map((ve: any) => {
            const v = ve.node;
            const optStr =
              v?.selectedOptions?.map((o: any) => `${o.name}:${o.value}`).join(" / ") ||
              v?.title ||
              "";
            return {
              id: v.id,                       // variant GID
              productId: p.id,
              sku: v.sku || "",
              label: [p.title, optStr].filter(Boolean).join(" — "),
              productTitle: p.title,
              options: v.selectedOptions || [],
            };
          }) || []
        );
      }) || [];

    return json({ok: true, items});
  } catch (err: any) {
    return json({ok: false, error: err?.message || String(err)}, {status: 200});
  }
}
