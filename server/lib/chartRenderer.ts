export type ChartType = "bar" | "horizontal_bar" | "line" | "area" | "pie" | "scatter";

export interface ChartDataPoint {
  label: string;
  value: number;
  x?: number;
  series?: string;
}

export interface RenderChartInput {
  type: ChartType;
  title: string;
  xLabel?: string;
  yLabel?: string;
  data: ChartDataPoint[];
}

const PALETTE = [
  "#2563eb", // Blue
  "#0d9488", // Teal
  "#d97706", // Amber
  "#dc2626", // Crimson
  "#7c3aed", // Violet
  "#059669", // Emerald
  "#db2777", // Pink
  "#4f46e5", // Indigo
  "#ea580c", // Orange
  "#0284c7", // Sky
];

function escapeXml(text: string): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatNum(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  if (Number.isInteger(n)) return n.toLocaleString("en-US");
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function truncateLabel(label: string, maxLen = 18): string {
  const clean = String(label ?? "").trim();
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, maxLen - 1)}…`;
}

/**
 * Generates a clean, crisp publication-grade SVG chart and returns a base64 data URI.
 * Works directly in <img> tags and renders cleanly onto HTML5 canvas for PDF export.
 */
export function renderSvgChartDataUri(input: RenderChartInput): string {
  const width = 800;
  const height = 460;
  const points = (Array.isArray(input.data) ? input.data : [])
    .filter((d) => d && typeof d.value === "number" && Number.isFinite(d.value))
    .slice(0, 30);

  if (points.length === 0) {
    const emptySvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <rect width="${width}" height="${height}" fill="#ffffff" rx="12"/>
      <text x="${width / 2}" y="${height / 2}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="16" fill="#64748b">No numeric data available for "${escapeXml(input.title)}"</text>
    </svg>`;
    return `data:image/svg+xml;base64,${Buffer.from(emptySvg, "utf8").toString("base64")}`;
  }

  let bodySvg = "";

  if (input.type === "pie") {
    bodySvg = renderPieSvg(points, width, height);
  } else if (input.type === "horizontal_bar") {
    bodySvg = renderHorizontalBarSvg(points, width, height, input.xLabel);
  } else if (input.type === "line" || input.type === "area") {
    bodySvg = renderLineSvg(points, width, height, input.type === "area", input.xLabel, input.yLabel);
  } else if (input.type === "scatter") {
    bodySvg = renderScatterSvg(points, width, height, input.xLabel, input.yLabel);
  } else {
    bodySvg = renderVerticalBarSvg(points, width, height, input.xLabel, input.yLabel);
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="#ffffff"/>
    <text x="36" y="38" font-family="system-ui, -apple-system, BlinkMacSystemFont, sans-serif" font-size="18" font-weight="700" fill="#0f172a">${escapeXml(truncateLabel(input.title, 70))}</text>
    <line x1="36" y1="52" x2="${width - 36}" y2="52" stroke="#e2e8f0" stroke-width="1"/>
    ${bodySvg}
  </svg>`;

  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

function renderVerticalBarSvg(
  points: ChartDataPoint[],
  width: number,
  height: number,
  xLabel?: string,
  yLabel?: string,
): string {
  const padLeft = 78;
  const padRight = 36;
  const padTop = 76;
  const padBottom = 86;
  const chartW = width - padLeft - padRight;
  const chartH = height - padTop - padBottom;

  const maxVal = Math.max(...points.map((p) => p.value), 0);
  const minVal = Math.min(...points.map((p) => p.value), 0);
  const range = maxVal - minVal || 1;
  const yScale = (v: number) => padTop + chartH - ((v - minVal) / range) * chartH;
  const zeroY = yScale(0);

  let out = "";
  const ticks = 5;
  for (let i = 0; i <= ticks; i++) {
    const val = minVal + (range * i) / ticks;
    const y = yScale(val);
    out += `<line x1="${padLeft}" y1="${y.toFixed(1)}" x2="${width - padRight}" y2="${y.toFixed(1)}" stroke="#f1f5f9" stroke-width="1"/>`;
    out += `<text x="${padLeft - 10}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-family="ui-monospace, monospace" font-size="11" fill="#64748b">${escapeXml(formatNum(val))}</text>`;
  }

  out += `<line x1="${padLeft}" y1="${zeroY.toFixed(1)}" x2="${width - padRight}" y2="${zeroY.toFixed(1)}" stroke="#cbd5e1" stroke-width="1.2"/>`;

  const step = chartW / points.length;
  const barW = Math.max(10, Math.min(54, step * 0.64));
  const rotateLabels = points.length > 7;

  points.forEach((pt, idx) => {
    const cx = padLeft + step * idx + step / 2;
    const bx = cx - barW / 2;
    const vy = yScale(pt.value);
    const barTop = Math.min(vy, zeroY);
    const barH = Math.max(2, Math.abs(zeroY - vy));
    const color = PALETTE[idx % PALETTE.length];

    out += `<rect x="${bx.toFixed(1)}" y="${barTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="4" fill="${color}" opacity="0.92"/>`;

    if (points.length <= 14) {
      const textY = pt.value >= 0 ? barTop - 6 : barTop + barH + 13;
      out += `<text x="${cx.toFixed(1)}" y="${textY.toFixed(1)}" text-anchor="middle" font-family="ui-monospace, monospace" font-size="10.5" font-weight="600" fill="#334155">${escapeXml(formatNum(pt.value))}</text>`;
    }

    const labelStr = escapeXml(truncateLabel(pt.label, rotateLabels ? 14 : 16));
    if (rotateLabels) {
      out += `<text x="${cx.toFixed(1)}" y="${height - padBottom + 16}" text-anchor="end" transform="rotate(-32 ${cx.toFixed(1)} ${height - padBottom + 16})" font-family="system-ui, sans-serif" font-size="11" fill="#475569">${labelStr}</text>`;
    } else {
      out += `<text x="${cx.toFixed(1)}" y="${height - padBottom + 20}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11.5" fill="#475569">${labelStr}</text>`;
    }
  });

  if (xLabel) {
    out += `<text x="${padLeft + chartW / 2}" y="${height - 14}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" font-weight="600" fill="#475569">${escapeXml(xLabel)}</text>`;
  }
  if (yLabel) {
    out += `<text x="18" y="${padTop + chartH / 2}" text-anchor="middle" transform="rotate(-90 18 ${padTop + chartH / 2})" font-family="system-ui, sans-serif" font-size="12" font-weight="600" fill="#475569">${escapeXml(yLabel)}</text>`;
  }

  return out;
}

function renderHorizontalBarSvg(
  points: ChartDataPoint[],
  width: number,
  height: number,
  xLabel?: string,
): string {
  const items = points.slice(0, 14);
  const padLeft = 170;
  const padRight = 84;
  const padTop = 72;
  const padBottom = 46;
  const chartW = width - padLeft - padRight;
  const chartH = height - padTop - padBottom;

  const maxVal = Math.max(...items.map((p) => Math.abs(p.value)), 1);
  const step = chartH / items.length;
  const barH = Math.max(12, Math.min(28, step * 0.65));

  let out = "";
  for (let i = 0; i <= 4; i++) {
    const val = (maxVal * i) / 4;
    const x = padLeft + (chartW * i) / 4;
    out += `<line x1="${x.toFixed(1)}" y1="${padTop}" x2="${x.toFixed(1)}" y2="${height - padBottom}" stroke="#f1f5f9" stroke-width="1"/>`;
    out += `<text x="${x.toFixed(1)}" y="${height - padBottom + 16}" text-anchor="middle" font-family="ui-monospace, monospace" font-size="10.5" fill="#64748b">${escapeXml(formatNum(val))}</text>`;
  }

  items.forEach((pt, idx) => {
    const cy = padTop + step * idx + step / 2;
    const by = cy - barH / 2;
    const bw = Math.max(3, (Math.abs(pt.value) / maxVal) * chartW);
    const color = PALETTE[idx % PALETTE.length];

    out += `<text x="${padLeft - 12}" y="${(cy + 4).toFixed(1)}" text-anchor="end" font-family="system-ui, sans-serif" font-size="11.5" fill="#334155">${escapeXml(truncateLabel(pt.label, 22))}</text>`;
    out += `<rect x="${padLeft}" y="${by.toFixed(1)}" width="${bw.toFixed(1)}" height="${barH.toFixed(1)}" rx="4" fill="${color}" opacity="0.92"/>`;
    out += `<text x="${(padLeft + bw + 8).toFixed(1)}" y="${(cy + 4).toFixed(1)}" font-family="ui-monospace, monospace" font-size="11" font-weight="600" fill="#1e293b">${escapeXml(formatNum(pt.value))}</text>`;
  });

  if (xLabel) {
    out += `<text x="${padLeft + chartW / 2}" y="${height - 10}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" font-weight="600" fill="#475569">${escapeXml(xLabel)}</text>`;
  }
  return out;
}

function renderLineSvg(
  points: ChartDataPoint[],
  width: number,
  height: number,
  isArea: boolean,
  xLabel?: string,
  yLabel?: string,
): string {
  const padLeft = 78;
  const padRight = 36;
  const padTop = 76;
  const padBottom = 82;
  const chartW = width - padLeft - padRight;
  const chartH = height - padTop - padBottom;

  const vals = points.map((p) => p.value);
  const maxVal = Math.max(...vals);
  const minVal = Math.min(...vals, 0);
  const range = maxVal - minVal || 1;

  const xScale = (i: number) =>
    points.length === 1 ? padLeft + chartW / 2 : padLeft + (i / (points.length - 1)) * chartW;
  const yScale = (v: number) => padTop + chartH - ((v - minVal) / range) * chartH;

  let out = "";
  for (let i = 0; i <= 5; i++) {
    const val = minVal + (range * i) / 5;
    const y = yScale(val);
    out += `<line x1="${padLeft}" y1="${y.toFixed(1)}" x2="${width - padRight}" y2="${y.toFixed(1)}" stroke="#f1f5f9" stroke-width="1"/>`;
    out += `<text x="${padLeft - 10}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-family="ui-monospace, monospace" font-size="11" fill="#64748b">${escapeXml(formatNum(val))}</text>`;
  }

  const coords = points.map((p, i) => ({ x: xScale(i), y: yScale(p.value), pt: p }));
  const linePath = coords
    .map((c, i) => `${i === 0 ? "M" : "L"} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`)
    .join(" ");

  if (isArea && coords.length > 1) {
    const baseY = padTop + chartH;
    const areaPath = `${linePath} L ${coords[coords.length - 1].x.toFixed(1)} ${baseY} L ${coords[0].x.toFixed(1)} ${baseY} Z`;
    out += `<path d="${areaPath}" fill="#2563eb" opacity="0.14"/>`;
  }

  out += `<path d="${linePath}" fill="none" stroke="#2563eb" stroke-width="2.8" stroke-linejoin="round" stroke-linecap="round"/>`;

  const labelStep = Math.max(1, Math.ceil(points.length / 8));
  coords.forEach((c, i) => {
    out += `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="4" fill="#ffffff" stroke="#2563eb" stroke-width="2.2"/>`;
    if (points.length <= 10) {
      out += `<text x="${c.x.toFixed(1)}" y="${(c.y - 10).toFixed(1)}" text-anchor="middle" font-family="ui-monospace, monospace" font-size="10" font-weight="600" fill="#1e293b">${escapeXml(formatNum(c.pt.value))}</text>`;
    }
    if (i % labelStep === 0 || i === points.length - 1) {
      out += `<text x="${c.x.toFixed(1)}" y="${height - padBottom + 20}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#475569">${escapeXml(truncateLabel(c.pt.label, 14))}</text>`;
    }
  });

  if (xLabel) {
    out += `<text x="${padLeft + chartW / 2}" y="${height - 14}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" font-weight="600" fill="#475569">${escapeXml(xLabel)}</text>`;
  }
  if (yLabel) {
    out += `<text x="18" y="${padTop + chartH / 2}" text-anchor="middle" transform="rotate(-90 18 ${padTop + chartH / 2})" font-family="system-ui, sans-serif" font-size="12" font-weight="600" fill="#475569">${escapeXml(yLabel)}</text>`;
  }

  return out;
}

function renderScatterSvg(
  points: ChartDataPoint[],
  width: number,
  height: number,
  xLabel?: string,
  yLabel?: string,
): string {
  const padLeft = 78;
  const padRight = 36;
  const padTop = 76;
  const padBottom = 72;
  const chartW = width - padLeft - padRight;
  const chartH = height - padTop - padBottom;

  const xs = points.map((p, i) => (typeof p.x === "number" && Number.isFinite(p.x) ? p.x : i));
  const ys = points.map((p) => p.value);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const rX = maxX - minX || 1;
  const rY = maxY - minY || 1;

  const sx = (x: number) => padLeft + ((x - minX) / rX) * chartW;
  const sy = (y: number) => padTop + chartH - ((y - minY) / rY) * chartH;

  let out = "";
  for (let i = 0; i <= 4; i++) {
    const vy = minY + (rY * i) / 4;
    const y = sy(vy);
    out += `<line x1="${padLeft}" y1="${y.toFixed(1)}" x2="${width - padRight}" y2="${y.toFixed(1)}" stroke="#f1f5f9" stroke-width="1"/>`;
    out += `<text x="${padLeft - 10}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-family="ui-monospace, monospace" font-size="11" fill="#64748b">${escapeXml(formatNum(vy))}</text>`;

    const vx = minX + (rX * i) / 4;
    const x = sx(vx);
    out += `<line x1="${x.toFixed(1)}" y1="${padTop}" x2="${x.toFixed(1)}" y2="${height - padBottom}" stroke="#f8fafc" stroke-width="1"/>`;
    out += `<text x="${x.toFixed(1)}" y="${height - padBottom + 18}" text-anchor="middle" font-family="ui-monospace, monospace" font-size="10.5" fill="#64748b">${escapeXml(formatNum(vx))}</text>`;
  }

  points.forEach((pt, idx) => {
    const cx = sx(xs[idx]);
    const cy = sy(pt.value);
    out += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="5.5" fill="#2563eb" opacity="0.75" stroke="#ffffff" stroke-width="1.5"/>`;
  });

  if (xLabel) {
    out += `<text x="${padLeft + chartW / 2}" y="${height - 14}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" font-weight="600" fill="#475569">${escapeXml(xLabel)}</text>`;
  }
  if (yLabel) {
    out += `<text x="18" y="${padTop + chartH / 2}" text-anchor="middle" transform="rotate(-90 18 ${padTop + chartH / 2})" font-family="system-ui, sans-serif" font-size="12" font-weight="600" fill="#475569">${escapeXml(yLabel)}</text>`;
  }
  return out;
}

function renderPieSvg(points: ChartDataPoint[], width: number, height: number): string {
  const positives = points.filter((p) => p.value > 0).slice(0, 10);
  const total = positives.reduce((acc, p) => acc + p.value, 0);
  if (total <= 0) {
    return `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="#64748b">Pie chart requires positive values</text>`;
  }

  const cx = 250;
  const cy = 255;
  const r = 140;
  const innerR = 68;

  let startAngle = -Math.PI / 2;
  let out = "";

  positives.forEach((pt, idx) => {
    const pct = pt.value / total;
    const sliceAngle = pct * Math.PI * 2;
    const endAngle = startAngle + sliceAngle;
    const largeArc = sliceAngle > Math.PI ? 1 : 0;

    const x1 = cx + r * Math.cos(startAngle);
    const y1 = cy + r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle);
    const y2 = cy + r * Math.sin(endAngle);

    const ix1 = cx + innerR * Math.cos(endAngle);
    const iy1 = cy + innerR * Math.sin(endAngle);
    const ix2 = cx + innerR * Math.cos(startAngle);
    const iy2 = cy + innerR * Math.sin(startAngle);

    const color = PALETTE[idx % PALETTE.length];
    const d = [
      `M ${x1.toFixed(1)} ${y1.toFixed(1)}`,
      `A ${r} ${r} 0 ${largeArc} 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`,
      `L ${ix1.toFixed(1)} ${iy1.toFixed(1)}`,
      `A ${innerR} ${innerR} 0 ${largeArc} 0 ${ix2.toFixed(1)} ${iy2.toFixed(1)}`,
      "Z",
    ].join(" ");

    out += `<path d="${d}" fill="${color}" stroke="#ffffff" stroke-width="2"/>`;
    startAngle = endAngle;

    // Legend item on right
    const ly = 96 + idx * 32;
    out += `<rect x="440" y="${ly - 10}" width="12" height="12" rx="3" fill="${color}"/>`;
    out += `<text x="460" y="${ly}" font-family="system-ui, sans-serif" font-size="12.5" font-weight="500" fill="#1e293b">${escapeXml(truncateLabel(pt.label, 24))}</text>`;
    out += `<text x="760" y="${ly}" text-anchor="end" font-family="ui-monospace, monospace" font-size="12" font-weight="600" fill="#475569">${(pct * 100).toFixed(1)}% (${escapeXml(formatNum(pt.value))})</text>`;
  });

  out += `<text x="${cx}" y="${cy - 4}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#64748b">TOTAL</text>`;
  out += `<text x="${cx}" y="${cy + 16}" text-anchor="middle" font-family="ui-monospace, monospace" font-size="15" font-weight="700" fill="#0f172a">${escapeXml(formatNum(total))}</text>`;

  return out;
}
