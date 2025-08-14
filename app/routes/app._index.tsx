import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);       // ensure session
  return redirect("/app/sort");            // go straight to your sorter UI
}

export default function AppIndex() {
  return null; // no UI; we immediately redirect
}
