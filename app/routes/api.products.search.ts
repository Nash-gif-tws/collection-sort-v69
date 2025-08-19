// app/routes/api.products.search.ts
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { ensureAdminOrJsonReauth } from "~/server/reauth.server";

async function doSearch(request: Request) {
  const auth = await ensureAdminOrJsonReauth(request);
  if ("reauth" in auth && auth.reauth) {
    return json({ ok: false, reauthUrl: auth.reauthUrl }, { status: 401 });
  }

  const { admin } = auth;
  const url = new URL(request.url);
  let q = (url.searchParams.get("q") || "").trim();
  let first = Math.min(
    Math.max(parseInt(url.searchParams.get("first") || "10", 10) || 10, 1),
    25
  );

  // Also support POST body {q, first}
  if (request.method === "POST") {
    const form = await request.formData();
    q = (form.get("q")?.toString() || q).trim();
    const f = parseInt(form.get("first")?.toString() || "", 10);
    if (!Number.isNaN(f)) first = Math.min(Math.max(f, 1), 25);
  }

  if (!q) return json({ ok: true, items: [] });

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
  if (data?.errors?.length) {
    return json({ ok: false, error: data.errors[0]?.message || "GraphQL error" }, { status: 500 });
  }

  const items =
    data?.data?.products?.edges?.flatMap((e: any) => {
      const p = e?.node ?? {};
      return p?.variants?.edges?.map((ve: any) => {
        const v = ve?.node ?? {};
        const optStr = (v?.selectedOptions ?? [])
          .map((o: any) => `${o.name}:${o.value}`)
          .join(" / ");
        return {
          id: v.id,                 // REQUIRED by pickers
          productId: p.id,
          productTitle: p.title,
          vendor: p.vendor || "",
          variantId: v.id,
          variantTitle: v.title || "",
          sku: v.sku || "",
          options: v.selectedOptions || [],
          label: [p.title, optStr || v.title].filter(Boolean).join(" — "),
        };
      }) || [];
    }) || [];

  // Return multiple shapes some UIs expect
  return json({ ok: true, items, results: items, data: items });
}

export async function loader(args: LoaderFunctionArgs) { return doSearch(args.request); }
export async function action(args: ActionFunctionArgs) { return doSearch(args.request); }
