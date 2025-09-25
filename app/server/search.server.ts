// app/server/search.server.ts
import type { AdminApiContext } from "@shopify/shopify-app-remix/server"; // type only

export async function searchVariants(admin: AdminApiContext["admin"], q: string, first = 10) {
  const query = `title:*${q}* OR sku:*${q}* OR vendor:*${q}*`;
  const resp = await admin.graphql(
    `#graphql
     query ProductSearch($query: String!, $first: Int!) {
       products(first: $first, query: $query) {
         nodes {
           id
           title
           vendor
           variants(first: 50) {
             nodes {
               id
               title
               sku
               selectedOptions { name value }
             }
           }
         }
       }
     }`,
    { variables: { query, first: Math.min(Math.max(first || 10, 1), 25) } }
  );

  const data = await resp.json();

  if (data?.errors?.length) {
    const message = data.errors.map((e: any) => e?.message).join("; ");
    throw new Error(message || "GraphQL error");
  }

  const items =
    (data?.data?.products?.nodes ?? []).flatMap((p: any) =>
      (p?.variants?.nodes ?? []).map((v: any) => ({
        id: v.id, // picker needs this
        productId: p.id,
        productTitle: p.title,
        vendor: p.vendor || "",
        variantId: v.id,
        variantTitle: v.title || "",
        sku: v.sku || "",
        options: v.selectedOptions || [],
        label: `${p.title} — ${v.title}${v.sku ? ` [${v.sku}]` : ""}`,
      }))
    ) ?? [];

  return items;
}
