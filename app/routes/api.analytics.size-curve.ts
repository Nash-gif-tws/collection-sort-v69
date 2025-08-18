// app/routes/api.analytics.size-curve.ts
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { ensureAdminOrJsonReauth } from "~/server/reauth.server";
import { prisma } from "~/db.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await ensureAdminOrJsonReauth(request);
  const url = new URL(request.url);
  const fromISO = url.searchParams.get("from") ?? new Date(Date.now() - 30*864e5).toISOString().slice(0,10);
  const toISO   = url.searchParams.get("to")   ?? new Date().toISOString().slice(0,10);

  const from = new Date(fromISO);
  const toExclusive = new Date(new Date(toISO).getTime() + 86400000);

  const rows = await prisma.$queryRaw<{ size: string | null; units: number }[]>`
    SELECT COALESCE(v."size",'Unknown') AS size, SUM(ol."qty")::int AS units
    FROM "OrderLine" ol
    JOIN "Variant" v ON v."id" = ol."variantId"
    WHERE ol."createdAt" >= ${from}
      AND ol."createdAt" < ${toExclusive}
    GROUP BY 1
    ORDER BY units DESC
  `;

  const total = rows.reduce((a,r)=>a + Number(r.units||0), 0);
  const series = rows.map(r => ({
    size: r.size ?? "Unknown",
    units: Number(r.units||0),
    pct: total ? Math.round((Number(r.units||0) * 1000 / total))/10 : 0
  }));

  return json({ ok: true, series });
}
