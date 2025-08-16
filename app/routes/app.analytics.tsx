// app/routes/app.analytics.tsx
import type { LoaderFunctionArgs, HeadersFunction } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { useEffect, useState } from "react";
import {
  Page, Layout, Card, BlockStack, InlineStack,
  Text, Button, TextField, Banner
} from "@shopify/polaris";

export const headers: HeadersFunction = () => ({
  "Content-Security-Policy":
    "frame-ancestors https://admin.shopify.com https://*.myshopify.com;",
});

export async function loader({ request }: LoaderFunctionArgs) {
  // Guard access via Admin session
  await authenticate.admin(request);
  return null;
}

export default function AnalyticsPage() {
  const [from, setFrom] = useState<string>(new Date(Date.now() - 30*864e5).toISOString().slice(0,10));
  const [to, setTo]     = useState<string>(new Date().toISOString().slice(0,10));
  const [data, setData] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg]   = useState<string | null>(null);

  async function load() {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`/api/analytics/overview?from=${from}&to=${to}`, { credentials: "include" });
      const j = await r.json();
      if (j.ok) setData(j); else setMsg(j.error || "Failed");
    } catch (e:any) {
      setMsg(e.message || String(e));
    } finally { setBusy(false); }
  }

  async function ingest() {
    setBusy(true); setMsg("Ingesting last 90 days…");
    try {
      const r = await fetch(`/api/analytics/ingest?days=90`, { credentials: "include" });
      const j = await r.json();
      setMsg(j.ok ? `Ingested orders: ${j.ordersProcessed}, lines: ${j.linesProcessed}` : `Error: ${j.error}`);
    } catch (e:any) {
      setMsg(e.message || String(e));
    } finally { setBusy(false); }
  }

  useEffect(() => { load(); }, []); // load once on mount

  return (
    <Page title="Analytics (MVP)">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack gap="400">
                <TextField label="From" type="date" value={from} onChange={setFrom}/>
                <TextField label="To"   type="date" value={to}   onChange={setTo}/>
                <Button onClick={load} disabled={busy}>Refresh</Button>
                <Button variant="secondary" onClick={ingest} disabled={busy}>Ingest last 90 days</Button>
              </InlineStack>

              {msg && <Banner tone={msg.startsWith("Error") ? "critical" : "info"}>{msg}</Banner>}

              {data && (
                <BlockStack gap="300">
                  <Text as="h3" variant="headingSm">Totals</Text>
                  <Text>Revenue: ${Number(data.totals.revenue).toFixed(2)} — Units: {data.totals.units}</Text>

                  <Text as="h3" variant="headingSm">By day</Text>
                  <div style={{fontFamily:"monospace", fontSize:12, whiteSpace:"pre-wrap"}}>
                    {data.series.map((r:any) =>
                      `${new Date(r.day).toISOString().slice(0,10)}  $${Number(r.revenue).toFixed(2)}  (${r.units}u)`
                    ).join("\n")}
                  </div>

                  <Text as="h3" variant="headingSm">Top products (revenue)</Text>
                  <div style={{fontFamily:"monospace", fontSize:12, whiteSpace:"pre-wrap"}}>
                    {data.top.map((t:any) =>
                      `${t.title ?? t.productId}  $${Number(t.revenue).toFixed(2)}  (${t.units}u)`
                    ).join("\n")}
                  </div>
                </BlockStack>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
