import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";

/**
 * Root route (/) → /app, while preserving query params like ?host=&shop=
 * This is critical so App Bridge keeps working in the Admin iframe.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const to = new URL("/app", url.origin);
  // keep the entire query string (?host=...&shop=...&embedded=1, etc.)
  to.search = url.search;
  return redirect(to.toString());
}
