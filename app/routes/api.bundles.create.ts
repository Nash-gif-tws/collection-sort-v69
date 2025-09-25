// app/routes/api.bundles.create.ts
import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "~/shopify.server";

type VariantOptionValue = { optionName?: string; optionId?: string; name: string };
type CreateVariantInput = {
  // Use ONLY if your product has options:
  optionValues?: VariantOptionValue[];

  // Money must be a string
  price?: string;

  // sku must live under inventoryItem
  inventoryItem?: { sku?: string; tracked?: boolean; requiresShipping?: boolean };

  // Set qty at create time (later changes use inventoryAdjustQuantities)
  inventoryQuantities?: Array<{ locationId: string; availableQuantity: number }>;

  // For bundles: make parent-only purchasable as bundle
  requiresComponents?: boolean;
};

type BundleComponent = { variantId: string; qty: number };

type Body = {
  title: string;
  productOptions?: Array<{ name: string; values: Array<{ name: string }> }>;
  createVariants: CreateVariantInput[];
  bundleComponents?: BundleComponent[]; // components to attach to the SELECTED parent variant
  parentIndex?: number; // which created variant is the bundle parent (default 0)
  autoPublish?: boolean; // publish to Online Store publication if true
};

export async function action({ request }: ActionFunctionArgs) {
  try {
    if (request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, { status: 405 });
    }

    const { admin } = await authenticate.admin(request);
    const body = (await request.json()) as Body;

    // 0) validate input
    if (!body?.title) return json({ ok: false, error: "Missing title" }, { status: 400 });
    if (!Array.isArray(body.createVariants) || body.createVariants.length === 0) {
      return json({ ok: false, error: "createVariants must be a non-empty array" }, { status: 400 });
    }

    // 1) Create product (with options if provided)
    const createRes = await admin.graphql(
      `#graphql
      mutation CreateProduct($product: ProductInput!) {
        productCreate(product: $product) {
          product { id title options { id name } }
          userErrors { field message }
        }
      }`,
      {
        variables: {
          product: body.productOptions ? { title: body.title, productOptions: body.productOptions } : { title: body.title },
        },
      }
    );
    const createData = await createRes.json();
    const pErr = createData?.data?.productCreate?.userErrors ?? [];
    if (pErr.length) return json({ ok: false, step: "productCreate", errors: pErr }, { status: 400 });

    const productId: string | undefined = createData?.data?.productCreate?.product?.id;
    if (!productId) return json({ ok: false, error: "Product not created" }, { status: 500 });

    // 2) Bulk create variants (IMPORTANT: use optionValues, not "options")
    const bulkRes = await admin.graphql(
      `#graphql
      mutation BulkVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkCreate(productId: $productId, variants: $variants) {
          productVariants { id title selectedOptions { name value } }
          userErrors { field message }
        }
      }`,
      { variables: { productId, variants: body.createVariants } }
    );
    const bulkData = await bulkRes.json();
    const vErr = bulkData?.data?.productVariantsBulkCreate?.userErrors ?? [];
    if (vErr.length) return json({ ok: false, step: "productVariantsBulkCreate", errors: vErr }, { status: 400 });

    const createdVariants: Array<{ id: string; title: string }> =
      bulkData?.data?.productVariantsBulkCreate?.productVariants ?? [];
    if (!createdVariants.length) {
      return json({ ok: false, error: "No variants created" }, { status: 500 });
    }

    // 3) Attach bundle components to parent variant (if provided)
    let bundleRelResult: any = null;
    const parentIndex = Number.isInteger(body.parentIndex) ? (body.parentIndex as number) : 0;
    const parentVariantId = createdVariants[parentIndex]?.id;

    if (parentVariantId && Array.isArray(body.bundleComponents) && body.bundleComponents.length > 0) {
      const componentsInput = body.bundleComponents.map((c) => ({
        id: c.variantId,
        quantity: Number(c.qty),
      }));

      const relRes = await admin.graphql(
        `#graphql
        mutation CreateBundleComponents($input: [ProductVariantRelationshipUpdateInput!]!) {
          productVariantRelationshipBulkUpdate(input: $input) {
            parentProductVariants {
              id
              productVariantComponents(first: 50) {
                nodes { id quantity productVariant { id } }
              }
            }
            userErrors { code field message }
          }
        }`,
        {
          variables: {
            input: [
              {
                parentProductVariantId: parentVariantId,
                productVariantRelationshipsToCreate: componentsInput,
              },
            ],
          },
        }
      );
      const relData = await relRes.json();
      const relErr = relData?.data?.productVariantRelationshipBulkUpdate?.userErrors ?? [];
      if (relErr.length) return json({ ok: false, step: "bundleComponents", errors: relErr }, { status: 400 });
      bundleRelResult = relData?.data?.productVariantRelationshipBulkUpdate?.parentProductVariants ?? null;
    }

    // 4) Publish to Online Store (optional)
    let publishResult: any = null;
    if (body.autoPublish) {
      // Fetch publications and pick "Online Store"
      const pubsRes = await admin.graphql(
        `#graphql
        query Publications {
          publications(first: 20) { edges { node { id name } } }
        }`
      );
      const pubsData = await pubsRes.json();
      const pubs: Array<{ id: string; name: string }> =
        pubsData?.data?.publications?.edges?.map((e: any) => e.node) ?? [];
      const onlineStore = pubs.find((p) => /online store/i.test(p.name)) || pubs[0];

      if (onlineStore) {
        const pubRes = await admin.graphql(
          `#graphql
          mutation Publish($id: ID!, $pub: ID!) {
            publishablePublish(id: $id, input: { publicationId: $pub }) {
              publishable { ... on Product { id status } }
              userErrors { field message }
            }
          }`,
          { variables: { id: productId, pub: onlineStore.id } }
        );
        const pubData = await pubRes.json();
        const pubErr = pubData?.data?.publishablePublish?.userErrors ?? [];
        if (pubErr.length) return json({ ok: false, step: "publishablePublish", errors: pubErr }, { status: 400 });
        publishResult = pubData?.data?.publishablePublish?.publishable ?? null;
      }
    }

    // 5) Done
    return json(
      {
        ok: true,
        productId,
        variantsCreated: createdVariants,
        bundleParentVariantId: parentVariantId ?? null,
        bundleWiring: bundleRelResult,
        published: publishResult,
      },
      { status: 200 }
    );
  } catch (err: any) {
    return json({ ok: false, error: err?.message || String(err) }, { status: 500 });
  }
}
