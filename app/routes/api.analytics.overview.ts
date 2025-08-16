// app/routes/api.analytics.overview.ts
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "~/shopify.server";
import { prisma } from "~/db.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);

  const url = new URL(request.url);
  const fromISO =
    url.searchParams.get("from") ||
    new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const toISO =
    url.searchParams.get("to") ||
    new Date().toISOString().slice(0, 10);

  const rows = await prisma.$queryRaw<
    { day: Date; units: number; revenue: number }[]
  >`
    SELECT
      date_trunc('day', "createdAt") as day,
      SUM("qty")::int as units,
      SUM("netAmount")::numeric as revenue
    FROM "OrderLine"
    WHERE "createdAt" >= ${new Date(fromISO)}
      AND "createdAt" < ${new Date(toISO)} + interval '1 day'
    GROUP BY 1
    ORDER BY 1
  `;

  const top = await prisma.$queryRaw<
    { productId: string; title: string | null; units: number; revenue: number }[]
  >`
    SELECT
      ol."productId" as "productId",
      p."title" as title,
      SUM(ol."qty")::int as units,
      SUM(ol."netAmount")::numeric as revenue
    FROM "OrderLine" ol
    LEFT JOIN "Product" p ON p."id" = ol."productId"
    WHERE ol."createdAt" >= ${new Date(fromISO)}
      AND ol."createdAt" < ${new Date(toISO)} + interval '1 day'
    GROUP BY 1,2
    ORDER BY revenue DESC
    LIMIT 20
  `;

  const totals = rows.reduce(
    (acc, r) => {
      acc.units += Number(r.units || 0);
      acc.revenue += Number(r.revenue || 0);
      return acc;
    },
    { units: 0, revenue: 0 }
  );

  return json({ ok: true, fromISO, toISO, totals, series: rows, top });
}
