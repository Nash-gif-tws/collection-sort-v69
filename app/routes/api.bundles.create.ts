import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { ensureAdminOrJsonReauth } from "~/server/reauth.server";

/**
 * POST /api/bundles.create
 * body: { title: string, components: [{ variantId: string, qty: number }] }
 */
export async function action({ request }: ActionFunctionArgs) {
  // If auth is missing, return 401 JSON with { reauthUrl } so the client can bounce to /auth.
  const guard = await ensureAdminOrJsonReauth(request);
  if ("reauthUrl" in guard) {
    return json({ reauthUrl: guard.reauthUrl }, { status: 401 });
  }
  const { admin } = guard;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Bad JSON" }, { status: 400 });
  }

  const title = String(body?.title || "").trim();
  const components = Array.isArray(body?.components) ? body.components : [];

  if (!title) return json({ ok: false, error: "Title is required" }, { status: 400 });
  if (!components.length) return json({ ok: false, error: "At least one component required" }, { status: 400 });

  // normalize qty
  for (const c of components) c.qty = Math.max(1, Number(c.qty || 1));

  // 1) Pull component inventory for availability calculation
  const ids = components.map((c: any) => c.variantId);
  const invRes = await admin.graphql(
    `#graphql
    query($ids:[ID!]!) {
      nodes(ids:$ids) {
        ... on ProductVariant {
          id
          inventoryLevels(first: 50) {
            edges { node { available } }
          }
        }
      }
    }`,
    { variables: { ids } }
  );
  const invData = await invRes.json();
  if (!invData?.data?.nodes) {
    return json({ ok: false, error: "Failed to read inventory" }, { status: 500 });
  }

  const findVariant = (vid: string) => invData.data.nodes.find((n: any) => n?.id === vid);
  const available = (v: any) =>
    (v?.inventoryLevels?.edges || []).reduce((s: number, e: any) => s + (e?.node?.available ?? 0), 0);

  // 2) Compute bundle capacity = floor(min(available_i / qty_i))
  let bundleAvailable = Infinity;
  for (const c of components) {
    const v = findVariant(c.variantId);
    const a = available(v);
    const cap = Math.floor(a / c.qty);
    bundleAvailable = Math.min(bundleAvailable, cap);
  }
  if (!Number.isFinite(bundleAvailable)) bundleAvailable = 0;

  // 3) Create a bundle product (single variant for now)
  const createRes = await admin.graphql(
    `#graphql
    mutation($input: ProductInput!) {
      productCreate(input: $input) {
        product {
          id
          handle
          title
          variants(first: 1) { edges { node { id } } }
        }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        input: {
          title,
          status: "ACTIVE",
          variants: [{ title: "Default" }],
        },
      },
    }
  );
  const create = await createRes.json();
  const err = create?.data?.productCreate?.userErrors?.[0]?.message;
  if (err) return json({ ok: false, error: err }, { status: 400 });

  const productId = create.data.productCreate.product.id;

  // 4) Save components into a product metafield so we can resync later
  await admin.graphql(
    `#graphql
    mutation SetBundleMeta($ownerId: ID!, $value: String!) {
      metafieldsSet(metafields: [{
        ownerId: $ownerId,
        namespace: "bundle",
        key: "components",
        type: "json",
        value: $value
      }]) {
        userErrors { message field }
      }
    }`,
    { variables: { ownerId: productId, value: JSON.stringify({ components }) } }
  );

  // (Optional) You can set an initial inventory on the bundle variant to bundleAvailable here,
  // but Shopify's inventory mutations vary by API version. We'll handle live syncing below.
  return json({ ok: true, productId, bundleAvailable });
}

export const loader = () => json({ ok: false, error: "POST only" }, { status: 405 });
