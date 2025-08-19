import { json, type ActionFunctionArgs } from "@remix-run/node";
import { prisma } from "~/db.server";
import { requireAdminAndShop } from "~/server/reauth.server";

export async function action({ request }: ActionFunctionArgs) {
  const { shop, admin } = await requireAdminAndShop(request);
  const { parentTitle, options, children } = await request.json();

  if (!parentTitle || !Array.isArray(options) || !Array.isArray(children) || children.length === 0) {
    return json({ ok: false, error: "Missing parentTitle/options/children" }, { status: 400 });
  }

  // Create PARENT product
  const cpRes = await admin.graphql(`#graphql
    mutation CreateParent($input: ProductInput!) {
      productCreate(input: $input) {
        product { id title combinedListingRole }
        userErrors { field message }
      }
    }`,
    { variables: { input: { title: parentTitle, status: "ACTIVE", combinedListingRole: "PARENT", options: options.map((o:any)=>o.name) } } }
  );
  const cpJson = await cpRes.json();
  const pErr = cpJson.data?.productCreate?.userErrors?.[0];
  if (pErr) return json({ ok: false, error: pErr.message }, { status: 400 });

  const parentProductId = cpJson.data.productCreate.product.id;

  // Attach children and define options/values
  const updRes = await admin.graphql(`#graphql
    mutation UpdateCL($parentProductId: ID!, $productsAdded: [ChildProductRelationInput!], $optionsAndValues: [OptionAndValueInput!]) {
      combinedListingUpdate(parentProductId: $parentProductId, productsAdded: $productsAdded, optionsAndValues: $optionsAndValues) {
        product { id }
        userErrors { code field message }
      }
    }`,
    {
      variables: {
        parentProductId,
        optionsAndValues: options.map((o:any)=>({ name: o.name, values: o.values })),
        productsAdded: children.map((c:any)=>({
          childProductId: c.childProductId,
          selectedParentOptionValues: c.selectedParentOptionValues
        })),
      },
    }
  );
  const updJson = await updRes.json();
  const uErr = updJson.data?.combinedListingUpdate?.userErrors?.[0];
  if (uErr) return json({ ok: false, error: uErr.message }, { status: 400 });

  // Persist config
  const rec = await prisma.combinedParent.create({
    data: {
      shop,
      parentProductId,
      title: parentTitle,
      children: {
        createMany: {
          data: children.map((c:any)=>({
            productId: c.childProductId,
            parentOptionMap: c.selectedParentOptionValues ? c.selectedParentOptionValues : undefined,
          })),
        },
      },
    },
    include: { children: true },
  });

  return json({ ok: true, parentProductId, record: rec });
}
