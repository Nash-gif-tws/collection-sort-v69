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

async function fetchInventoryWithNames(names: string[]) {
  const res = await admin.graphql(
    `#graphql
    query Inv($ids:[ID!]!, $names:[String!]!) {
      nodes(ids:$ids) {
        ... on ProductVariant {
          id
          inventoryItem {
            inventoryLevels(first: 50) {
              edges {
                node {
                  quantities(names: $names) {
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
    { variables: { ids: variantIds, names } }
  );
  return res.json();
}

let invJson: any;
let availByVariant = new Map<string, number>();

// Try UPPERCASE first
invJson = await fetchInventoryWithNames(["AVAILABLE"]);

// If Shopify complains about the 'names' arg or similar, try lowercase
if (Array.isArray(invJson?.errors) && invJson.errors.length) {
  const needsLower = invJson.errors.some((e: any) =>
    String(e?.message || "").includes("Argument 'names'")
  );
  if (needsLower) {
    invJson = await fetchInventoryWithNames(["available"]);
  }
}

// If we still have an error (i.e., quantities not supported), fall back.
let usedFallbackVariantQuantity = false;
if (Array.isArray(invJson?.errors) && invJson.errors.length) {
  // Fallback: use deprecated ProductVariant.inventoryQuantity (total across locations)
  const res2 = await admin.graphql(
    `#graphql
    query InvFallback($ids:[ID!]!) {
      nodes(ids:$ids) {
        ... on ProductVariant {
          id
          inventoryQuantity
        }
      }
    }`,
    { variables: { ids: variantIds } }
  );
  const json2 = await res2.json();
  usedFallbackVariantQuantity = true;
  for (const n of json2?.data?.nodes ?? []) {
    if (!n?.id) continue;
    const qty = Number(n?.inventoryQuantity ?? 0);
    availByVariant.set(n.id, qty);
  }
} else {
  // Sum AVAILABLE across locations from quantities API
  for (const n of invJson?.data?.nodes ?? []) {
    if (!n?.id) continue;
    const total =
      n?.inventoryItem?.inventoryLevels?.edges?.reduce(
        (sum: number, e: any) => {
          const list = e?.node?.quantities ?? [];
          // prefer AVAILABLE (upper) otherwise available (lower)
          const q =
            list.find((q: any) => q?.name === "AVAILABLE")?.quantity ??
            list.find((q: any) => q?.name === "available")?.quantity ??
            0;
          return sum + Number(q || 0);
        },
        0
      ) ?? 0;
    availByVariant.set(n.id, total);
  }
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

