// app/routes/api.analytics.aging-stock.ts
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { ensureAdminOrJsonReauth } from "~/server/reauth.server";
import { prisma } from "~/db.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await ensureAdminOrJsonReauth(request);

  // Latest on-hand per variant
  const latest = await prisma.$queryRaw<{ variantId: string; onHand: number; productId: string }[]>`
    SELECT DISTINCT ON (i."variantId")
      i."variantId",
      i."onHand",
      v."productId"
    FROM "InventorySnapshot" i
    JOIN "Variant" v ON v."id" = i."variantId"
    ORDER BY i."variantId", i."snapshotDate" DESC
  `;

  // Product ages
  const productMap = new Map<string, Date | null>();
  const productIds = [...new Set(latest.map(r=>r.productId))];
  if (productIds.length) {
    const prods = await prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, createdAt: true },
    });
    for (const p of prods) productMap.set(p.id, p.createdAt ?? null);
  }

  const bands: Record<string, number> = { "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
  const now = Date.now();

  for (const row of latest) {
    const created = productMap.get(row.productId);
    const ageDays = created ? Math.floor((now - new Date(created).getTime())/86400000) : 0;
    const band =
      ageDays <= 30 ? "0-30" :
      ageDays <= 60 ? "31-60" :
      ageDays <= 90 ? "61-90" : "90+";
    bands[band] += Number(row.onHand || 0);
  }

  const series = Object.entries(bands).map(([band, onHand]) => ({ band, onHand }));
  return json({ ok: true, bands: series });
}
