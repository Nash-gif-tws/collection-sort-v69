// app/routes/app.tsx
import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import { authenticate } from "../shopify.server";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    await authenticate.admin(request);
    return { apiKey: process.env.SHOPIFY_API_KEY || "" };
  } catch {
    const url = new URL(request.url);
    // derive shop, preserve host
    let shop = url.searchParams.get("shop") || "";
    const host = url.searchParams.get("host") || "";
    if (!shop && host) {
      try {
        const decoded = Buffer.from(host, "base64").toString("utf-8");
        shop = decoded.split("/")[0] || "";
      } catch {}
    }

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><meta name="robots" content="noindex"/></head>
<body><script>
(function () {
  var p = new URLSearchParams(window.location.search);
  var shop = p.get("shop") || ${JSON.stringify(shop)};
  var host = p.get("host") || ${JSON.stringify(host)};
  var qs = [];
  if (shop) qs.push("shop=" + encodeURIComponent(shop));
  if (host) qs.push("host=" + encodeURIComponent(host));
  var target = "/auth" + (qs.length ? "?" + qs.join("&") : "");
  if (window.top === window.self) { window.location.href = target; }
  else { window.top.location.href = target; }
})();
</script></body></html>`;
    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy":
          "frame-ancestors https://admin.shopify.com https://*.myshopify.com;",
      },
    });
  }
}

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();
  return (
    <AppProvider isEmbeddedApp apiKey={apiKey}>
      <NavMenu>
        <Link to="/app" rel="home">Home</Link>
        <Link to="/app/sort">Sort</Link>
        <Link to="/app/analytics">Analytics</Link>
       <Link to="/app/packages">Packages & Joined</Link>
      </NavMenu>
      <Outlet />
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (args) => {
  const base = new Headers(boundary.headers(args));
  base.set(
    "Content-Security-Policy",
    "frame-ancestors https://admin.shopify.com https://*.myshopify.com;"
  );
  return base;
};
