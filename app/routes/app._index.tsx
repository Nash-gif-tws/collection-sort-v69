import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";

/** /app → /app/sort, preserving ?host=&shop= */
export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const to = new URL("/app/sort", url.origin);
  to.search = url.search;
  return redirect(to.toString());
}
