// app/routes/api.analytics.ingest.ts
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Prisma } from "@prisma/client";
import { authenticate } from "~/shopify.server";
import { prisma } from "~/db.server";

const ORDERS_QUERY = `#graphql
  query OrdersPage($first: Int!, $after: String, $query: String!) {
    orders(first: $first, after: $after, query: $query) {
      edges {
        cursor
        node {
          id
          createdAt
          currencyCode
          lineItems(first: 100) {
            edges {
              node {
                id
                quantity
                discountedTotalSet { shopMoney { amount } }
                product { id title vendor createdAt }
                variant {
                  id title sku
                  selectedOptions { name value }
                  product { id }
                }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);

  const url = new URL(request.url);
  const days = Number(url.searchParams.get("days") || "90");
  const since = url.searchParams.get("since"); // YYYY-MM-DD
  const shop = session.shop;

  const sinceISO =
    since ??
    new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

  const search = `created_at:>=${sinceISO} AND financial_status:paid AND status:any`;

  let after: string | null = null;
  let ordersProcessed = 0;
  let linesProcessed = 0;

  while (true) {
    const res = await admin.graphql(ORDERS_QUERY, {
      variables: { first: 50, after, query: search },
    });
    const body = await res.json();
    const edges = body?.data?.orders?.edges ?? [];
    const pageInfo = body?.data?.orders?.pageInfo;

    for (const edge of edges) {
      ordersProcessed++;
      const o = edge.node;

      // page line items if needed
      let liEdges = o.lineItems.edges;
      let liHasNext = o.lineItems.pageInfo?.hasNextPage;
      let liAfter = o.lineItems.pageInfo?.endCursor ?? null;

      while (true) {
        for (const liEdge of liEdges) {
          const li = liEdge.node;
          linesProcessed++;

          const p = li.product;
          if (p?.id) {
            await prisma.product.upsert({
              where: { id: p.id },
              update: {
                title: p.title ?? "",
                vendor: p.vendor ?? null,
                createdAt: p.createdAt ? new Date(p.createdAt) : undefined,
              },
              create: {
                id: p.id,
                title: p.title ?? "",
                vendor: p.vendor ?? null,
                createdAt: p.createdAt ? new Date(p.createdAt) : null,
              },
            });
          }

          const v = li.variant;
          if (v?.id) {
            const size =
              v?.selectedOptions?.find((o: any) => /size/i.test(o.name))
                ?.value ?? null;
            const color =
              v?.selectedOptions?.find((o: any) => /colou?r/i.test(o.name))
                ?.value ?? null;

            await prisma.variant.upsert({
              where: { id: v.id },
              update: {
                productId: v.product?.id ?? (p?.id ?? undefined),
                title: v.title ?? null,
                sku: v.sku ?? null,
                size,
                color,
              },
              create: {
                id: v.id,
                productId: v.product?.id ?? (p?.id ?? ""),
                title: v.title ?? null,
                sku: v.sku ?? null,
                size,
                color,
              },
            });
          }

          const amt = Number(li.discountedTotalSet?.shopMoney?.amount ?? 0);
          await prisma.orderLine.upsert({
            where: { id: li.id },
            update: {},
            create: {
              id: li.id,
              orderId: o.id,
              createdAt: new Date(o.createdAt),
              productId: p?.id ?? null,
              variantId: v?.id ?? null,
              qty: Number(li.quantity ?? 0),
              currency: o.currencyCode ?? "AUD",
              netAmount: new Prisma.Decimal(isFinite(amt) ? amt : 0),
            } as any,
          });
        }

        if (!liHasNext) break;

        // fetch next page of line items for this order
        const resLI = await admin.graphql(
          `#graphql
           query OrderLineItems($id: ID!, $after: String) {
             order(id: $id) {
               lineItems(first: 100, after: $after) {
                 edges { node {
                   id quantity discountedTotalSet { shopMoney { amount } }
                   product { id title vendor createdAt }
                   variant {
                     id title sku
                     selectedOptions { name value }
                     product { id }
                   }
                 } }
                 pageInfo { hasNextPage endCursor }
               }
             }
           }`,
          { variables: { id: o.id, after: liAfter } }
        );
        const bodyLI = await resLI.json();
        liEdges = bodyLI?.data?.order?.lineItems?.edges ?? [];
        liHasNext = bodyLI?.data?.order?.lineItems?.pageInfo?.hasNextPage;
        liAfter = bodyLI?.data?.order?.lineItems?.pageInfo?.endCursor ?? null;
      }
    }

    if (!pageInfo?.hasNextPage) break;
    after = pageInfo?.endCursor ?? null;
  }

  await prisma.ingestCursor.upsert({
    where: { shop },
    update: { sinceISO },
    create: { shop, sinceISO },
  });

  return json({ ok: true, sinceISO, ordersProcessed, linesProcessed });
}
