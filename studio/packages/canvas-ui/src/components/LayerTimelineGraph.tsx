import { laneX, timelineEdges, type LayerTimeline } from "../layer-timeline";
// Lane colors are theme tokens (--lane-0 … --lane-5 in index.css).
const LANES = 6;
const lane = (i: number) => `var(--lane-${i % LANES})`;
export function LayerTimelineGraph({
  layout,
  centers,
  height,
  activeLayerId,
}: {
  layout: LayerTimeline;
  centers: readonly number[];
  height: number;
  activeLayerId: string | null;
}) {
  return (
    <svg
      className="layer-timeline-graph"
      width={layout.width}
      height={height}
      viewBox={`0 0 ${layout.width} ${height}`}
      aria-hidden="true"
    >
      {timelineEdges(layout, centers).map((edge) => (
        <path
          key={`${edge.kind}:${edge.to}`}
          data-relation={edge.kind}
          data-from={edge.from}
          data-to={edge.to}
          d={edge.d}
          fill="none"
          style={{ stroke: lane(edge.lane) }}
          strokeWidth={edge.kind === "redo" ? 1 : 1.5}
          strokeDasharray={edge.kind === "redo" ? "3 4" : undefined}
          opacity={edge.kind === "redo" ? 0.45 : 0.7}
        />
      ))}
      {layout.nodes.map((n) => {
        const x = laneX(n.lane),
          y = centers[n.row] ?? n.row * 78 + 37,
          active = n.id === activeLayerId,
          color = active ? "var(--accent)" : lane(n.lane);
        return (
          <g key={n.id} data-layer-dot={n.id}>
            {n.missingParent && (
              <path
                d={`M ${x} ${y - 17} V ${y - 5}`}
                style={{ stroke: color }}
                strokeDasharray="2 3"
              />
            )}
            {active && (
              <circle
                cx={x}
                cy={y}
                r="7"
                style={{ fill: "var(--accent-soft)" }}
              />
            )}
            <circle
              cx={x}
              cy={y}
              r={active ? 3.5 : 3}
              style={{
                fill: n.missingParent ? "var(--surface)" : color,
                stroke: color,
              }}
              strokeWidth="1.5"
            />
          </g>
        );
      })}
    </svg>
  );
}
