// app/routes/api.sort.ts
import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { sortCollection } from "../server/sortCollection";

export async function action({ request }: ActionFunctionArgs) {
  try {
    const { admin } = await authenticate.admin(request);
    const body = await request.json().catch(() => ({}));
    const { collectionId, topN, dryRun } = (body ?? {}) as {
      collectionId?: string;
      topN?: number;
      dryRun?: boolean;
    };

    if (!collectionId) {
      return json({ ok: false, error: "Missing collectionId" }, { status: 400 });
    }

    // ---- Helpers (scoped to this request so they can use `admin`) ----

    // Pull all products in the collection with variant availability
    async function fetchCollectionProducts(id: string) {
      const products: any[] = [];
      let after: string | null = null;
      for (;;) {
        const resp = await admin.graphql(
          `#graphql
           query Coll($id: ID!, $after: String){
             collection(id:$id){
               products(first: 250, after: $after) {
                 edges {
                   node {
                     id
                     title
                     variants(first: 100) {
                       edges { node { availableForSale price compareAtPrice } }
                     }
                   }
                 }
                 pageInfo { hasNextPage endCursor }
               }
             }
           }`,
          { variables: { id, after } }
        );
        const data = await resp.json() as any;
        const edges = data?.data?.collection?.products?.edges ?? [];
        products.push(...edges.map((e: any) => e.node));
        const info = data?.data?.collection?.products?.pageInfo;
        if (!info?.hasNextPage) break;
        after = info.endCursor;
      }
      return products;
    }

    // Count units sold per product over the last N days (90 by default)
    // Uses order search query (stable across Admin API versions)
    async function fetchSalesCounts(productIds: string[], days = 90) {
      if (productIds.length === 0) return {};
      const sinceISO = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      let after: string | null = null;
      const counts: Record<string, number> = {};
      const wanted = new Set(productIds);

      for (;;) {
        const resp = await admin.graphql(
          `#graphql
           query Orders($after: String, $q: String) {
             orders(first: 50, after: $after, query: $q, sortKey: CREATED_AT) {
               edges {
                 node {
                   id
                   createdAt
                   lineItems(first: 250) {
                     edges { node { quantity product { id } } }
                   }
                 }
               }
               pageInfo { hasNextPage endCursor }
             }
           }`,
          { variables: { after, q: `created_at:>=${sinceISO} AND financial_status:paid AND status:any` } }
        );

        const data = await resp.json() as any;
        const edges = data?.data?.orders?.edges ?? [];
        for (const e of edges) {
          for (const le of e.node.lineItems.edges) {
            const li = le.node;
            const pid = li?.product?.id;
            if (pid && wanted.has(pid)) {
              counts[pid] = (counts[pid] || 0) + (li.quantity ?? 0);
            }
          }
        }

        const info = data?.data?.orders?.pageInfo;
        if (!info?.hasNextPage) break;
        after = info.endCursor;
      }
      return counts;
    }

    // ---- Fetch & compute desired order ----

    const items = await fetchCollectionProducts(collectionId);
    const productIds = items.map((p: any) => p.id);
    const sales90 = await fetchSalesCounts(productIds, 90);

    const decorated = items.map((p: any) => {
      const variantInStock = p.variants.edges.reduce(
        (n: number, e: any) => n + (e.node.availableForSale ? 1 : 0),
        0
      );
      const inStock = variantInStock > 0;
      const sold90 = sales90[p.id] ?? 0;
      return { id: p.id, title: p.title, inStock, variantInStock, sold90 };
    });

    // Sort: In-stock → 90-day best-sellers → most variants in stock → Title
    const desired = decorated
      .sort((a, b) => {
        if (a.inStock !== b.inStock) return a.inStock ? -1 : 1;
        if (a.sold90 !== b.sold90) return b.sold90 - a.sold90;
        if (a.variantInStock !== b.variantInStock) return b.variantInStock - a.variantInStock;
        return a.title.localeCompare(b.title);
      })
      .map((x) => x.id);

    // ---- Dry run? Just preview the order ----
    if (dryRun) {
      return json({
        ok: true,
        dryRun: true,
        considered: desired.length,
        preview: desired.slice(0, Math.min(desired.length, 25)),
      });
    }

    // ---- Apply (Top-N cap optional) ----
    const DEFAULT_TOP_N = 500;
    const cap = Number.isFinite(topN as number)
      ? Math.max(0, Math.min(desired.length, Number(topN)))
      : DEFAULT_TOP_N;

    const toApply = desired.slice(0, cap);
    await sortCollection(request, { collectionId, desiredOrder: toApply });

    return json({
      ok: true,
      moved: toApply.length,
      considered: desired.length,
      appliedTopN: cap,
      note: "Sorted by: In-stock → 90d best-sellers → most variants in stock; OOS last",
    });
  } catch (err: any) {
    console.error("api/sort failed:", err);
    return json({ ok: false, error: err?.message || String(err) }, { status: 500 });
  }
}
