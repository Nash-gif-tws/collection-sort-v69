// app/routes/api.sort-all.ts
import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { sortCollection } from "../server/sortCollection";

// List all collection IDs (paginated)
async function fetchCollectionIds(admin: any) {
  const ids: { id: string; title: string }[] = [];
  let after: string | null = null;
  for (;;) {
    const r = await admin.graphql(`#graphql
      query($after:String){
        collections(first:50, after:$after){
          edges{ cursor node{ id title } }
          pageInfo{ hasNextPage endCursor }
        }
      }`, { variables: { after } });
    const j = await r.json() as any;
    const edges = j?.data?.collections?.edges ?? [];
    ids.push(...edges.map((e: any) => e.node));
    const pi = j?.data?.collections?.pageInfo;
    if (!pi?.hasNextPage) break;
    after = pi.endCursor;
  }
  return ids;
}

// Products in a collection with variant availability
async function fetchProductsWithVariants(admin: any, collectionId: string) {
  const products: any[] = [];
  let after: string | null = null;
  for (;;) {
    const r = await admin.graphql(`#graphql
      query($id:ID!, $after:String){
        collection(id:$id){
          products(first:250, after:$after){
            edges{
              node{
                id title
                variants(first:100){ edges{ node{ availableForSale price compareAtPrice } } }
              }
            }
            pageInfo{ hasNextPage endCursor }
          }
        }
      }`, { variables: { id: collectionId, after } });
    const j = await r.json() as any;
    const edges = j?.data?.collection?.products?.edges ?? [];
    products.push(...edges.map((e: any) => e.node));
    const pi = j?.data?.collection?.products?.pageInfo;
    if (!pi?.hasNextPage) break;
    after = pi.endCursor;
  }
  return products;
}

// 90-day sales counts (stable fields only)
async function fetchSalesCounts(admin: any, productIds: string[], days = 90) {
  if (productIds.length === 0) return {};
  const sinceISO = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  let after: string | null = null;
  const counts: Record<string, number> = {};
  const wanted = new Set(productIds);

  for (;;) {
    const r = await admin.graphql(`#graphql
      query($after:String,$q:String){
        orders(first:50, after:$after, query:$q, sortKey:CREATED_AT){
          edges{
            cursor
            node{
              id createdAt
              lineItems(first:250){ edges{ node{ quantity product{ id } } } }
            }
          }
          pageInfo{ hasNextPage endCursor }
        }
      }`, { variables: { after, q: `created_at:>=${sinceISO} AND financial_status:paid AND status:any` } });
    const j = await r.json() as any;
    const edges = j?.data?.orders?.edges ?? [];
    for (const e of edges) {
      for (const le of e.node.lineItems.edges) {
        const li = le.node;
        const pid = li?.product?.id;
        if (pid && wanted.has(pid)) counts[pid] = (counts[pid] || 0) + (li.quantity ?? 0);
      }
    }
    const pi = j?.data?.orders?.pageInfo;
    if (!pi?.hasNextPage) break;
    after = pi.endCursor;
  }
  return counts;
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin } = await authenticate.admin(request);
  const body = await request.json().catch(() => ({}));
  const limit = Number(body.limit ?? 25);                 // max collections per run
  const topN  = Number.isFinite(body.topN) ? Number(body.topN) : 500;
  const dryRun = !!body.dryRun;

  const all = await fetchCollectionIds(admin);
  const target = all.slice(0, limit);

  const results: any[] = [];
  for (const c of target) {
    try {
      const items = await fetchProductsWithVariants(admin, c.id);
      if (items.length === 0) { results.push({ id: c.id, title: c.title, skipped: "empty" }); continue; }

      const productIds = items.map((p: any) => p.id);
      const sales90 = await fetchSalesCounts(admin, productIds, 90);

      const decorated = items.map((p: any) => {
        const variantInStock = p.variants.edges.reduce(
          (n: number, e: any) => n + (e.node.availableForSale ? 1 : 0), 0
        );
        const inStock = variantInStock > 0;
        const sold90 = sales90[p.id] ?? 0;
        return { id: p.id, title: p.title, inStock, variantInStock, sold90 };
      });

      // In-stock → 90d best-sellers → most variants in stock → title
      const desired = decorated.sort((a, b) => {
        if (a.inStock !== b.inStock) return a.inStock ? -1 : 1;
        if (a.sold90 !== b.sold90) return b.sold90 - a.sold90;
        if (a.variantInStock !== b.variantInStock) return b.variantInStock - a.variantInStock;
        return a.title.localeCompare(b.title);
      }).map(x => x.id);

      if (dryRun) {
        results.push({ id: c.id, title: c.title, considered: desired.length, preview: desired.slice(0, 10) });
      } else {
        const toApply = desired.slice(0, topN);
        await sortCollection(request, { collectionId: c.id, desiredOrder: toApply });
        results.push({ id: c.id, title: c.title, moved: toApply.length, considered: desired.length });
      }

      // polite throttle
      await new Promise(r => setTimeout(r, 400));
    } catch (e: any) {
      results.push({ id: c.id, title: c.title, error: e?.message || String(e) });
      await new Promise(r => setTimeout(r, 800));
    }
  }

  return json({ ok: true, processed: results.length, results });
}
