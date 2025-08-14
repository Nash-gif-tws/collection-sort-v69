import { authenticate } from "../shopify.server";

type GID = string;

export async function sortCollection(
  request: Request,
  { collectionId, desiredOrder }: { collectionId: GID; desiredOrder: GID[] }
) {
  const { admin } = await authenticate.admin(request);

  // Ensure MANUAL sorting
  await admin.graphql(`#graphql
    mutation($id: ID!){
      collectionUpdate(input:{id:$id, sortOrder: MANUAL}) {
        userErrors { message }
      }
    }`, { variables: { id: collectionId } });

  // Reorder in chunks of ≤250 and poll the job each time
   const moves = desiredOrder.map((id, idx) => ({ id, newPosition: String(idx) }));
  for (let i = 0; i < moves.length; i += 250) {
    const chunk = moves.slice(i, i + 250);
    const resp = await admin.graphql(`#graphql
      mutation($id: ID!, $moves: [MoveInput!]!){
        collectionReorderProducts(id:$id, moves:$moves){
          job { id }
          userErrors { message }
        }
      }`, { variables: { id: collectionId, moves: chunk } });

    const json = await resp.json() as any;
    const jobId = json?.data?.collectionReorderProducts?.job?.id;
    if (!jobId) continue;

    for (;;) {
      const jr = await admin.graphql(`#graphql
        query($id: ID!){ job(id:$id){ id done } }`, { variables: { id: jobId } });
      const j = await jr.json() as any;
      if (j?.data?.job?.done) break;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}
