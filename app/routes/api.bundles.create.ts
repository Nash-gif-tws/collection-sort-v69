// app/routes/api.bundles.create.ts
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "~/shopify.server";

type Component = { variantId: string; qty: number };

export async function loader(_args: LoaderFunctionArgs) {
  // POST only
  return json({ ok: false, error: "POST only" }, { status: 405 });
}

export async function action({ request }: ActionFunctionArgs) {
  // --- Parse & validate ---
  let title = "";
  let components: Component[] = [];
  try {
    const body = await request.json();
    title = (body?.title || "").trim();
    components = Array.isArray(body?.components) ? body.components : [];
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  if (!title) {
    return json({ ok: false, error: "Missing title" }, { status: 400 });
  }
  if (!components.length) {
    return json({ ok: false, error: "Add at least one component" }, { status: 400 });
  }
  for (const c of components) {
    if (!c?.variantId || !/gid:\/\//.test(c.variantId)) {
      return json({ ok: false, error: `Bad variantId: ${c?.variantId}` }, { status: 400 });
    }
    if (!Number.isFinite(c?.qty) || c.qty <= 0) {
      return json({ ok: false, error: `Bad qty for ${c.variantId}` }, { status: 400 });
    }
  }

  // --- Auth (JSON reauth instead of HTML) ---
  let admin: any;
  try {
    ({ admin } = await authenticate.admin(request));
  } catch {
    const url = new URL(request.url);
    const shop = url.searchParams.get("shop") || "";
    const host = url.searchParams.get("host") || "";
    const qs = [shop && `shop=${encodeURIComponent(shop)}`, host && `host=${encodeURIComponent(host)}`]
      .filter(Boolean)
      .join("&");
    return json({ ok: false, reauthUrl: `/auth${qs ? `?${qs}` : ""}` }, { status: 401 });
  }

  // --- Optional: compute capacity from inventory (best-effort) ---
  let capacity: number | null = null;
  try {
    const ids = components.map((c) => c.variantId);
    const invRes = await admin.graphql(
      `#graphql
      query BundleCapacity($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant {
            id
            inventoryItem {
              inventoryLevels(first: 50) {
                edges {
                  node {
                    available
                  }
                }
              }
            }
          }
        }
      }`,
      { variables: { ids } }
    );
    const inv = await invRes.json();

    // If schema changes or no data, guard
    if (inv?.errors) throw new Error(inv.errors?.[0]?.message || "Inventory query error.");

    const availMap = new Map<string, number>();
    for (const n of inv?.data?.nodes || []) {
      if (!n?.id) continue;
      const levels = n?.inventoryItem?.inventoryLevels?.edges || [];
      const total = levels.reduce((sum: number, e: any) => sum + (Number(e?.node?.available ?? 0) || 0), 0);
      availMap.set(n.id, total);
    }

    // capacity = min( floor(available / requiredQty) ) across components
    capacity = components.reduce((acc, c) => {
      const have = availMap.get(c.variantId) ?? 0;
      const capForThis = Math.floor(have / (c.qty || 1));
      return acc === null ? capForThis : Math.min(acc, capForThis);
    }, null as number | null);
    if (capacity === null) capacity = 0;
  } catch (e) {
    // Don’t fail bundle creation because capacity calc broke
    console.error("Capacity calc failed:", e);
    capacity = null;
  }

  // --- Create a DRAFT product to represent the bundle ---
  try {
    // Store components as JSON in a product metafield
    const metafieldValue = JSON.stringify({
      components,               // [{ variantId, qty }]
      kind: "bundle",
      version: 1,
    });

    const createRes = await admin.graphql(
      `#graphql
      mutation BundleCreate($input: ProductInput!) {
        productCreate(input: $input) {
          product {
            id
            handle
            title
            status
          }
          userErrors { field message }
        }
      }`,
      {
        variables: {
          input: {
            title,
            status: "DRAFT",
            productType: "Bundle",
            // One default variant; merchant can adjust price/images later
            variants: [{ title: "Default", requiresShipping: true }],
            metafields: [
              {
                namespace: "custom",
                key: "bundle_components",
                type: "json",
                value: metafieldValue,
              },
            ],
          },
        },
      }
    );

    const created = await createRes.json();

    if (created?.errors?.length) {
      return json(
        { ok: false, error: created.errors[0]?.message || "GraphQL error (productCreate)" },
        { status: 200 }
      );
    }
    const ue = created?.data?.productCreate?.userErrors;
    if (ue?.length) {
      return json(
        { ok: false, error: ue[0]?.message || "User error (productCreate)", details: ue },
        { status: 200 }
      );
    }

    const productId = created?.data?.productCreate?.product?.id;
    if (!productId) {
      return json({ ok: false, error: "No productId returned" }, { status: 200 });
    }

    return json({ ok: true, productId, capacity });
  } catch (e: any) {
    console.error("Bundle create failed:", e);
    return json({ ok: false, error: e?.message || String(e) }, { status: 200 });
  }
}
