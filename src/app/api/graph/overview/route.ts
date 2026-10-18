import { graphStatus, graphRun } from "@/lib/graph";
import { ensureSeed } from "@/lib/seed";

export const dynamic = "force-dynamic";

interface VizNodeRow {
  key: string;
  label: string;
  props: Record<string, unknown>;
}
interface VizEdgeRow {
  from: string;
  to: string;
  type: string;
}

export async function GET() {
  await ensureSeed();
  const status = await graphStatus();
  const [overview, nodeSample, edgeSample] = await Promise.all([
    graphRun<{
      byLabel: Record<string, number>;
      byType: Record<string, number>;
      total: number;
      edgeTotal: number;
    }>("graphOverview"),
    graphRun<VizNodeRow[]>("vizNodes"),
    graphRun<VizEdgeRow[]>("vizEdges"),
  ]);

  // Sample through the graph driver so live FalkorDB engines render too.
  const nodes = nodeSample.data ?? [];
  const index = new Map(nodes.map((n, i) => [n.key, i]));
  const edges = (edgeSample.data ?? [])
    .filter((e) => index.has(e.from) && index.has(e.to))
    .slice(0, 300);

  return Response.json({
    status,
    overview: overview.data,
    viz: {
      nodes: nodes.map((n) => ({
        key: n.key,
        label: n.label,
        name: String(n.props.ticker ?? n.props.name ?? n.props.title ?? n.key),
        props: n.props,
      })),
      edges: edges.map((e) => ({
        from: index.get(e.from),
        to: index.get(e.to),
        type: e.type,
      })),
    },
  });
}
