// app/routes/api.products.search.ts
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { requireAdminAndShop } from "~/server/reauth.server";

/**
 * GET /api/products.search?q=term&first=10
 * Returns lightweight items to drive the bundle component picker.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const { admin } = await requireAdminAndShop(request);

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  const first = Math.min(
    Math.max(parseInt(url.searchParams.get("first") || "10", 10) || 10, 1),
    25
  );

  if (!q) return json({ ok: true, items: [] });

  // Use Admin GraphQL product search (title, sku, vendor)
  // Note: Shopify product search supports sku: and title: filters.
  const query = `title:*${q}* OR sku:*${q}* OR vendor:*${q}*`;

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

  const data = await resp.json();

  // Flatten to variant-level suggestions
  const items =
    data?.data?.products?.edges?.flatMap((e: any) => {
      const p = e.node;
      return p.variants?.edges?.map((ve: any) => {
        const v = ve.node;
        const optStr =
          v?.selectedOptions?.map((o: any) => `${o.name}:${o.value}`).join(" / ") || v?.title || "";
        return {
          id: v.id,
          productId: p.id,
          sku: v.sku || "",
          label: [p.title, optStr].filter(Boolean).join(" — "),
          productTitle: p.title,
          options: v.selectedOptions || [],
        };
      }) || [];
    }) || [];

  return json({ ok: true, items });
}
