import type { LoaderFunctionArgs, HeadersFunction } from "@remix-run/node";
import { authenticate } from "~/shopify.server";
import { useEffect, useState } from "react";
import {
  Page, Layout, Card, BlockStack, InlineStack,
  Text, Button, TextField, Banner, Tabs, DataTable
} from "@shopify/polaris";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  BarChart, Bar, PieChart, Pie, Legend
} from "recharts";

export const headers: HeadersFunction = () => ({
  "Content-Security-Policy": "frame-ancestors https://admin.shopify.com https://*.myshopify.com;",
});

export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);
  return null;
}

export default function AnalyticsPage() {
  const [from, setFrom] = useState<string>(new Date(Date.now() - 30*864e5).toISOString().slice(0,10));
  const [to, setTo] = useState<string>(new Date().toISOString().slice(0,10));
  const [tab, setTab] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [overview, setOverview] = useState<any>(null);
  const [sizeCurve, setSizeCurve] = useState<any>(null);
  const [colorCurve, setColorCurve] = useState<any>(null);
  const [kpis, setKpis] = useState<any>(null);
  const [aging, setAging] = useState<any>(null);

  async function call(url: string) {
    const r = await fetch(url, { credentials: "include" });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || "Failed");
    return j;
  }

  async function refreshAll() {
    setBusy(true); setMsg(null);
    try {
      const [ov, sc, cc, kp, ag] = await Promise.all([
        call(`/api/analytics/overview?from=${from}&to=${to}`),
        call(`/api/analytics/size-curve?from=${from}&to=${to}`),
        call(`/api/analytics/color-curve?from=${from}&to=${to}`),
        call(`/api/analytics/kpis?days=${Math.max(14, Math.round((new Date(to).getTime()-new Date(from).getTime())/86400000))}`),
        call(`/api/analytics/aging-stock`),
      ]);
      setOverview(ov); setSizeCurve(sc); setColorCurve(cc); setKpis(kp); setAging(ag);
    } catch (e:any) {
      setMsg(e.message || String(e));
    } finally { setBusy(false); }
  }

  async function ingestOrders() {
    setBusy(true); setMsg("Ingesting orders (90d)...");
    try {
      const j = await call(`/api/analytics/ingest?days=90`);
      setMsg(`Orders: ${j.ordersProcessed}, lines: ${j.linesProcessed}`);
    } catch (e:any) { setMsg(e.message || String(e)); }
    finally { setBusy(false); }
  }

  async function ingestInventory() {
    setBusy(true); setMsg("Snapshotting inventory (today)...");
    try {
      const j = await call(`/api/analytics/ingest/inventory`);
      setMsg(`Inventory snapshots: ${j.snapshots} for ${j.variants} variants`);
    } catch (e:any) { setMsg(e.message || String(e)); }
    finally { setBusy(false); }
  }

  useEffect(() => { refreshAll(); }, []);

  const tabs = [
    { id: 't-ov', content: 'Overview', panelID: 'p-ov' },
    { id: 't-size', content: 'Size curve', panelID: 'p-size' },
    { id: 't-color', content: 'Color curve', panelID: 'p-color' },
    { id: 't-kpi', content: 'WOS & Sell-through', panelID: 'p-kpi' },
    { id: 't-age', content: 'Ageing stock', panelID: 'p-age' },
  ];

  return (
    <Page title="Analytics (Advanced)">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack gap="400">
                <TextField label="From" type="date" value={from} onChange={setFrom}/>
                <TextField label="To" type="date" value={to} onChange={setTo}/>
                <Button onClick={refreshAll} disabled={busy}>Refresh</Button>
                <Button variant="secondary" onClick={ingestOrders} disabled={busy}>Ingest orders (90d)</Button>
                <Button variant="secondary" onClick={ingestInventory} disabled={busy}>Snapshot inventory</Button>
              </InlineStack>
              {msg && <Banner tone={msg.startsWith("Error") ? "critical" : "info"}>{msg}</Banner>}

              <Tabs tabs={tabs} selected={tab} onSelect={setTab}>
                <div hidden={tab!==0} id="p-ov">{overview ? <OverviewBlock data={overview}/> : <Text>Loading…</Text>}</div>
                <div hidden={tab!==1} id="p-size">{sizeCurve ? <SizeCurveBlock data={sizeCurve}/> : <Text>Loading…</Text>}</div>
                <div hidden={tab!==2} id="p-color">{colorCurve ? <ColorCurveBlock data={colorCurve}/> : <Text>Loading…</Text>}</div>
                <div hidden={tab!==3} id="p-kpi">{kpis ? <KpiBlock data={kpis}/> : <Text>Loading…</Text>}</div>
                <div hidden={tab!==4} id="p-age">{aging ? <AgingBlock data={aging}/> : <Text>Loading…</Text>}</div>
              </Tabs>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

function OverviewBlock({ data }: { data:any }) {
  const series = (data.series||[]).map((r:any)=>({
    day: new Date(r.day).toISOString().slice(0,10),
    revenue: Number(r.revenue||0),
    units: Number(r.units||0),
  }));
  return (
    <BlockStack gap="300">
      <Text as="h3" variant="headingSm">Totals</Text>
      <Text>Revenue ${Number(data.totals.revenue).toFixed(2)} — Units {data.totals.units}</Text>
      <div style={{height:300}}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={series}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="day" />
            <YAxis yAxisId="left"/><YAxis yAxisId="right" orientation="right"/>
            <Tooltip />
            <Line type="monotone" dataKey="revenue" yAxisId="left" dot={false}/>
            <Line type="monotone" dataKey="units" yAxisId="right" dot={false}/>
          </LineChart>
        </ResponsiveContainer>
      </div>
    </BlockStack>
  );
}

function SizeCurveBlock({ data }: { data:any }) {
  const rows = data.series || [];
  return (
    <BlockStack gap="300">
      <Text as="h3" variant="headingSm">Size distribution</Text>
      <div style={{height:300}}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="size" /><YAxis /><Tooltip />
            <Bar dataKey="units"/>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </BlockStack>
  );
}

function ColorCurveBlock({ data }: { data:any }) {
  const rows = data.series || [];
  return (
    <BlockStack gap="300">
      <Text as="h3" variant="headingSm">Color distribution</Text>
      <div style={{height:300}}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={rows} dataKey="units" nameKey="color" outerRadius={120} label />
            <Tooltip />
          </PieChart>
        </ResponsiveContainer>
      </div>
    </BlockStack>
  );
}

function KpiBlock({ data }: { data:any }) {
  const t = data.totals;
  const riskRows = (data.risks||[]).map((r:any)=>[
    r.variantId.replace("gid://shopify/ProductVariant/","Variant/"),
    String(r.onHand),
    r.weekly.toFixed(2),
    r.wos === Infinity ? "∞" : r.wos.toFixed(1),
    `${r.sellThrough.toFixed(1)}%`,
  ]);

  return (
    <BlockStack gap="300">
      <Text as="h3" variant="headingSm">KPIs (last {Math.round(t.weeks)} weeks)</Text>
      <Text>On-hand: {t.onHand} — Units: {t.units} — Avg weekly: {t.avgWeekly.toFixed(1)} — Weighted WOS: {t.weightedWOS.toFixed(1)} — Sell-through: {t.sellThroughAll.toFixed(1)}%</Text>
      <Text as="h3" variant="headingSm">Top risk variants</Text>
      <DataTable
        columnContentTypes={['text','numeric','numeric','numeric','numeric']}
        headings={['Variant','On hand','Weekly','WOS','Sell-through']}
        rows={riskRows}
      />
    </BlockStack>
  );
}

function AgingBlock({ data }: { data:any }) {
  const rows = data.bands || [];
  return (
    <BlockStack gap="300">
      <Text as="h3" variant="headingSm">Ageing stock (by product createdAt)</Text>
      <div style={{height:300}}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="band" /><YAxis /><Tooltip />
            <Bar dataKey="onHand"/>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </BlockStack>
  );
}
