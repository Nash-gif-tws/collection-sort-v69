import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { requireAdminAndShop } from "~/server/reauth.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin } = await requireAdminAndShop(request);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  if (!q) return json({ ok: true, items: [] });

  const res = await admin.graphql(`#graphql
    query SearchProducts($q: String!) {
      products(first: 10, query: $q) {
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
    { variables: { q: `title:*${q}*` } }
  );

  const data = await res.json();
  const items = (data.data?.products?.nodes ?? []).flatMap((p: any) =>
    (p.variants?.nodes ?? []).map((v: any) => ({
      productId: p.id,
      productTitle: p.title,
      vendor: p.vendor,
      variantId: v.id,
      variantTitle: v.title,
      sku: v.sku,
      options: v.selectedOptions,
      label: `${p.title} — ${v.title}${v.sku ? ` [${v.sku}]` : ""}`,
    }))
  );

  return json({ ok: true, items });
}
