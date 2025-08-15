// app/server/strategy.server.ts
export type SortRule =
  | "in_stock"
  | "sales_90d"
  | "variants_in_stock"
  | "alpha"
  | "oos_last";

export const DEFAULT_RULES: SortRule[] = [
  "in_stock",
  "sales_90d",
  "variants_in_stock",
  "alpha",
  "oos_last",
];

// We use the Admin GraphQL client returned by `authenticate.admin(request)`:
// call as: await admin.graphql(query, { variables })
const READ_QUERY = `#graphql
  query Strategy($id: ID!) {
    collection(id: $id) {
      id
      metafield(namespace: "custom", key: "sort_rules") { value }
    }
  }
`;

export async function loadCollectionRules(
  admin: any,
  collectionId: string
): Promise<SortRule[]> {
  const res = await admin.graphql(READ_QUERY, { variables: { id: collectionId } });
  const { data } = await res.json();
  const raw = data?.collection?.metafield?.value;
  if (!raw) return DEFAULT_RULES;
  try {
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed?.rules) ? parsed.rules : DEFAULT_RULES;
    return arr.filter((r: string) =>
      (DEFAULT_RULES as string[]).includes(r)
    ) as SortRule[];
  } catch {
    return DEFAULT_RULES;
  }
}

const SAVE_MUTATION = `#graphql
  mutation SaveStrategy($id: ID!, $value: String!) {
    collectionUpdate(input: {
      id: $id,
      metafields: [{
        namespace: "custom",
        key: "sort_rules",
        type: "json",
        value: $value
      }]
    }) {
      userErrors { field message }
    }
  }
`;

export async function saveCollectionRules(
  admin: any,
  collectionId: string,
  rules: SortRule[]
) {
  const value = JSON.stringify({ rules });
  const res = await admin.graphql(SAVE_MUTATION, {
    variables: { id: collectionId, value },
  });
  const body = await res.json();
  const errs = body?.data?.collectionUpdate?.userErrors ?? [];
  if (errs.length) throw new Error(errs.map((e: any) => e.message).join("; "));
}
