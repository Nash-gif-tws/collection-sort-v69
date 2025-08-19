import type {LoaderFunctionArgs} from "@remix-run/node";
import {json} from "@remix-run/node";
import {authenticate} from "~/shopify.server";

export async function loader({request}: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const qRaw = (url.searchParams.get("q") || "").trim();
  const first = Math.min(
    Math.max(parseInt(url.searchParams.get("first") || "10", 10) || 10, 1),
    25
  );

  if (!qRaw) return json({ok: true, items: []});

  // Try auth; if missing, return JSON with reauthUrl
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

  const query = `title:*${qRaw}* OR sku:*${qRaw}* OR vendor:*${qRaw}*`;

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
      return json({ok: false, error: body.errors[0]?.message || "GraphQL error"});
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
              id: v.id,
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
    return json({ok: false, error: err?.message || String(err)});
  }
}
