// app/routes/api.analytics.kpis.ts
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { ensureAdminOrJsonReauth } from "~/server/reauth.server";
import { prisma } from "~/db.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await ensureAdminOrJsonReauth(request);

  const url = new URL(request.url);
  const days = Math.max(14, Number(url.searchParams.get("days") || "28"));
  const since = new Date(Date.now() - days*864e5);
  const weeks = days / 7;

  // Latest on-hand per variant
  const latest = await prisma.$queryRaw<{ variantId: string; onHand: number }[]>`
    SELECT DISTINCT ON ("variantId")
      "variantId",
      "onHand"
    FROM "InventorySnapshot"
    ORDER BY "variantId", "snapshotDate" DESC
  `;

  // Sales per variant in window
  const sales = await prisma.$queryRaw<{ variantId: string | null; units: number }[]>`
    SELECT "variantId", COALESCE(SUM("qty")::int, 0) AS units
    FROM "OrderLine"
    WHERE "createdAt" >= ${since}
    GROUP BY 1
  `;

  const onByVariant = new Map(latest.map(r => [r.variantId, Number(r.onHand || 0)]));
  const unitsByVariant = new Map(sales.map(r => [r.variantId ?? "", Number(r.units || 0)]));
  const allVariantIds = new Set<string>([...onByVariant.keys(), ...unitsByVariant.keys()]);

  let totalOn = 0, totalUnits = 0, totalWeekly = 0;
  const risk: { variantId: string; onHand: number; weekly: number; wos: number; sellThrough: number }[] = [];

  for (const vid of allVariantIds) {
    const on = onByVariant.get(vid) ?? 0;
    const u  = unitsByVariant.get(vid) ?? 0;
    const weekly = u / weeks;
    const wos = weekly > 0 ? on / weekly : Infinity;
    const sellThrough = (u + on) > 0 ? (u * 100) / (u + on) : 0;

    totalOn += on; totalUnits += u; totalWeekly += weekly;

    // pick variants with stock and low velocity as "risk"
    if (on > 0 && weekly < 1) {
      risk.push({ variantId: vid, onHand: on, weekly, wos, sellThrough });
    }
  }

  risk.sort((a,b) => (b.wos === a.wos ? b.onHand - a.onHand : b.wos - a.wos));
  const topRisk = risk.slice(0, 25);

  const weightedWOS = totalWeekly > 0 ? totalOn / totalWeekly : Infinity;
  const sellThroughAll = (totalUnits + totalOn) > 0 ? (totalUnits * 100) / (totalUnits + totalOn) : 0;

  return json({
    ok: true,
    totals: { weeks, onHand: totalOn, units: totalUnits, avgWeekly: totalWeekly, weightedWOS, sellThroughAll },
    risks: topRisk,
  });
}
