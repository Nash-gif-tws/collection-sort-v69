// app/routes/api.bundles.create.ts
import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "~/shopify.server";

type Component = { variantId: string; qty: number };

export async function action({ request }: ActionFunctionArgs) {
  try {
    const { admin } = await authenticate.admin(request);
    if (request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, { status: 405 });
    }

    const body = await request.json().catch(() => ({}));
    const title: string = (body?.title || "").trim();
    const components: Component[] = Array.isArray(body?.components) ? body.components : [];

    if (!title) return json({ ok: false, error: "Title is required" }, { status: 400 });
    if (!components.length)
      return json({ ok: false, error: "At least one component is required" }, { status: 400 });

    // --- 1) Compute inventory-based capacity across all locations ---
const variantIds = components.map((c) => c.variantId);

const invRes = await admin.graphql(
  `#graphql
  query Inv($ids:[ID!]!) {
    nodes(ids:$ids) {
      ... on ProductVariant {
        id
        inventoryItem {
          inventoryLevels(first: 50) {
            edges {
              node {
                # New shape: use quantities(names: [AVAILABLE])
                quantities(names: [AVAILABLE]) {
                  name
                  quantity
                }
              }
            }
          }
        }
      }
    }
  }`,
  { variables: { ids: variantIds } }
);

const invJson = await invRes.json();

// Sum AVAILABLE across all locations for each variant
const availByVariant = new Map<string, number>();
for (const n of invJson?.data?.nodes ?? []) {
  if (!n?.id) continue;
  const total =
    n?.inventoryItem?.inventoryLevels?.edges?.reduce(
      (sum: number, e: any) => {
        const qList = e?.node?.quantities ?? [];
        const avail = qList.find((q: any) => q?.name === "AVAILABLE")?.quantity ?? 0;
        return sum + Number(avail || 0);
      },
      0
    ) ?? 0;
  availByVariant.set(n.id, total);
}

// capacity = min(floor(available / qty)) across components
let capacity: number | null = null;
for (const c of components) {
  const have = Number(availByVariant.get(c.variantId) ?? 0);
  const need = Math.max(1, Number(c.qty) || 1);
  const capThis = Math.floor(have / need);
  capacity = capacity === null ? capThis : Math.min(capacity, capThis);
}
if (capacity === null) capacity = 0;

    // Optional: compute a default price (sum of parts once) for the shell variant
    // If you’d rather show computed total on the PDP, set this to 0.
    // We’ll fetch price via Storefront on the theme side anyway.
    // Here, we’ll set price to 0 to avoid any mismatch:
    const shellPrice = "0.00";

    // --- 2) Create product (without variants) ---
    const createProductRes = await admin.graphql(
      `#graphql
      mutation CreateProduct($input: ProductInput!) {
        productCreate(input: $input) {
          product { id handle status }
          userErrors { field message }
        }
      }`,
      {
        variables: {
          input: {
            title,
            productType: "Bundle",
            status: "DRAFT", // or "ACTIVE" if you want it immediately live
          },
        },
      }
    );
    const createProductJson = await createProductRes.json();
    const pErr = createProductJson?.data?.productCreate?.userErrors ?? [];
    if (pErr.length) {
      return json({ ok: false, error: pErr.map((e: any) => e.message).join(", ") }, { status: 400 });
    }
    const productId: string = createProductJson?.data?.productCreate?.product?.id;
    if (!productId) return json({ ok: false, error: "No productId from productCreate" }, { status: 500 });

    // --- 3) Create a single shell variant for the product ---
    const createVarRes = await admin.graphql(
      `#graphql
      mutation CreateVariant($input: ProductVariantInput!) {
        productVariantCreate(input: $input) {
          productVariant { id }
          userErrors { field message }
        }
      }`,
      {
        variables: {
          input: {
            productId,
            title: "Default",
            price: shellPrice, // decimal string
            // inventoryManagement: NOT_MANAGED is default now; we will explode lines in cart
          },
        },
      }
    );
    const createVarJson = await createVarRes.json();
    const vErr = createVarJson?.data?.productVariantCreate?.userErrors ?? [];
    if (vErr.length) {
      return json({ ok: false, error: vErr.map((e: any) => e.message).join(", ") }, { status: 400 });
    }
    const variantId: string = createVarJson?.data?.productVariantCreate?.productVariant?.id;

    // --- 4) Save metafields on the product ---
    const metafieldValue = JSON.stringify({
      kind: "bundle",
      version: 1,
      components: components.map((c) => ({
        variantId: c.variantId,
        qty: Math.max(1, Number(c.qty) || 1),
      })),
    });

    const mfInputs: any[] = [
      {
        ownerId: productId,
        namespace: "custom",
        key: "bundle_components",
        type: "json",
        value: metafieldValue,
      },
    ];
    if (capacity !== null) {
      mfInputs.push({
        ownerId: productId,
        namespace: "custom",
        key: "bundle_capacity",
        type: "number_integer",
        value: String(capacity),
      });
    }

    const mfRes = await admin.graphql(
      `#graphql
      mutation SaveMF($metafields:[MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id key namespace }
          userErrors { field message }
        }
      }`,
      { variables: { metafields: mfInputs } }
    );
    const mfJson = await mfRes.json();
    const mfErr = mfJson?.data?.metafieldsSet?.userErrors ?? [];
    if (mfErr.length) {
      return json({ ok: false, error: mfErr.map((e: any) => e.message).join(", ") }, { status: 400 });
    }

    return json({
      ok: true,
      productId,
      variantId,
      capacity,
    });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

