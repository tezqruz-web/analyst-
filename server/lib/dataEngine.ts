import { parseDelimitedText } from "./fileParser.ts";

export interface LoadedDataset {
  name: string;
  headers: string[];
  rows: Record<string, string | number | null>[];
  columnTypes: Record<string, "number" | "date" | "string">;
}

function tryParseNumber(raw: string): number | null {
  const cleaned = raw.trim().replace(/[$,%\s]/g, "").replace(/,/g, "");
  if (!cleaned) return null;
  if (!/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(cleaned)) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function isLikelyDate(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length < 6 || trimmed.length > 35) return false;
  if (/^\d{4}[-/]\d{1,2}([-/]\d{1,2})?/.test(trimmed)) return !Number.isNaN(Date.parse(trimmed));
  if (/^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$/.test(trimmed)) return !Number.isNaN(Date.parse(trimmed));
  return false;
}

export function loadDatasetsFromCsvFiles(
  files: Array<{ name: string; content?: string }>,
): LoadedDataset[] {
  const datasets: LoadedDataset[] = [];

  for (const file of files) {
    if (!file.content || !file.content.trim()) continue;
    const { headers, rows: rawRows } = parseDelimitedText(file.content, ",");
    if (headers.length === 0) continue;

    const columnTypes: Record<string, "number" | "date" | "string"> = {};
    const sampleSize = Math.min(rawRows.length, 200);

    for (let c = 0; c < headers.length; c++) {
      const col = headers[c];
      let nonEmpty = 0;
      let numericHits = 0;
      let dateHits = 0;

      for (let r = 0; r < sampleSize; r++) {
        const val = (rawRows[r]?.[c] ?? "").trim();
        if (!val) continue;
        nonEmpty++;
        if (tryParseNumber(val) !== null) numericHits++;
        else if (isLikelyDate(val)) dateHits++;
      }

      if (nonEmpty > 0 && numericHits / nonEmpty >= 0.8) {
        columnTypes[col] = "number";
      } else if (nonEmpty > 0 && dateHits / nonEmpty >= 0.8) {
        columnTypes[col] = "date";
      } else {
        columnTypes[col] = "string";
      }
    }

    const typedRows: Record<string, string | number | null>[] = rawRows.map((rawRow) => {
      const obj: Record<string, string | number | null> = {};
      for (let c = 0; c < headers.length; c++) {
        const col = headers[c];
        const raw = (rawRow[c] ?? "").trim();
        if (!raw) {
          obj[col] = null;
        } else if (columnTypes[col] === "number") {
          const num = tryParseNumber(raw);
          obj[col] = num !== null ? num : raw;
        } else {
          obj[col] = raw;
        }
      }
      return obj;
    });

    datasets.push({
      name: file.name,
      headers,
      rows: typedRows,
      columnTypes,
    });
  }

  return datasets;
}

function roundVal(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function computeNumericStats(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const median = n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[Math.floor(n / 2)];
  const p25 = sorted[Math.floor(n * 0.25)];
  const p75 = sorted[Math.floor(n * 0.75)];
  const variance = sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  return {
    count: n,
    sum: roundVal(sum),
    mean: roundVal(mean),
    median: roundVal(median),
    std: roundVal(std),
    min: roundVal(sorted[0]),
    p25: roundVal(p25),
    p75: roundVal(p75),
    max: roundVal(sorted[n - 1]),
  };
}

export function profileDatasets(datasets: LoadedDataset[]) {
  return datasets.map((ds) => {
    const columns = ds.headers.map((col) => {
      const type = ds.columnTypes[col];
      let nullCount = 0;
      const uniques = new Set<string>();
      const nums: number[] = [];
      const freq = new Map<string, number>();

      for (const row of ds.rows) {
        const v = row[col];
        if (v === null || v === undefined || v === "") {
          nullCount++;
          continue;
        }
        const s = String(v);
        uniques.add(s);
        if (typeof v === "number" && Number.isFinite(v)) {
          nums.push(v);
        } else if (type !== "number") {
          freq.set(s, (freq.get(s) ?? 0) + 1);
        }
      }

      const base: Record<string, unknown> = {
        name: col,
        type,
        nullCount,
        uniqueCount: uniques.size,
      };

      if (type === "number" && nums.length > 0) {
        base.stats = computeNumericStats(nums);
      } else {
        base.topValues = Array.from(freq.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 6)
          .map(([value, count]) => ({ value, count }));
      }
      return base;
    });

    return {
      dataset: ds.name,
      rowCount: ds.rows.length,
      columnCount: ds.headers.length,
      columns,
      sampleRows: ds.rows.slice(0, 5),
    };
  });
}

export interface DataQueryArgs {
  dataset?: string;
  operation: "group_aggregate" | "filter_sort" | "outliers" | "correlation" | "summary_stats";
  filters?: Array<{
    column: string;
    op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains";
    value: string | number;
  }>;
  groupBy?: string;
  metrics?: Array<{
    column: string;
    agg: "sum" | "avg" | "min" | "max" | "count" | "median" | "count_distinct";
    alias?: string;
  }>;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
  limit?: number;
  column?: string;
  columns?: string[];
}

function matchDataset(datasets: LoadedDataset[], name?: string): LoadedDataset | null {
  if (datasets.length === 0) return null;
  if (!name) return datasets[0];
  const lower = name.toLowerCase();
  return (
    datasets.find((d) => d.name.toLowerCase() === lower) ||
    datasets.find((d) => d.name.toLowerCase().includes(lower)) ||
    datasets[0]
  );
}

function applyFilters(
  rows: Record<string, string | number | null>[],
  filters?: DataQueryArgs["filters"],
) {
  if (!Array.isArray(filters) || filters.length === 0) return rows;
  return rows.filter((row) =>
    filters.every((f) => {
      const cell = row[f.column];
      if (cell === null || cell === undefined) return false;
      const numCell = typeof cell === "number" ? cell : Number(cell);
      const numVal = typeof f.value === "number" ? f.value : Number(f.value);
      const bothNumeric = Number.isFinite(numCell) && Number.isFinite(numVal);

      switch (f.op) {
        case "eq":
          return bothNumeric
            ? numCell === numVal
            : String(cell).toLowerCase() === String(f.value).toLowerCase();
        case "neq":
          return bothNumeric
            ? numCell !== numVal
            : String(cell).toLowerCase() !== String(f.value).toLowerCase();
        case "gt":
          return bothNumeric ? numCell > numVal : String(cell) > String(f.value);
        case "gte":
          return bothNumeric ? numCell >= numVal : String(cell) >= String(f.value);
        case "lt":
          return bothNumeric ? numCell < numVal : String(cell) < String(f.value);
        case "lte":
          return bothNumeric ? numCell <= numVal : String(cell) <= String(f.value);
        case "contains":
          return String(cell).toLowerCase().includes(String(f.value).toLowerCase());
        default:
          return true;
      }
    }),
  );
}

export function executeDataQuery(datasets: LoadedDataset[], args: DataQueryArgs): Record<string, unknown> {
  const ds = matchDataset(datasets, args.dataset);
  if (!ds) {
    return { error: "No dataset is loaded." };
  }

  const filtered = applyFilters(ds.rows, args.filters);
  const limit = Math.max(1, Math.min(args.limit ?? 25, 100));

  if (args.operation === "summary_stats") {
    const targetCols =
      Array.isArray(args.columns) && args.columns.length > 0
        ? args.columns.filter((c) => ds.headers.includes(c))
        : ds.headers.filter((c) => ds.columnTypes[c] === "number");

    const stats: Record<string, unknown> = {};
    for (const col of targetCols) {
      const nums = filtered
        .map((r) => r[col])
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
      stats[col] = computeNumericStats(nums);
    }
    return { dataset: ds.name, matchedRows: filtered.length, stats };
  }

  if (args.operation === "group_aggregate") {
    const groupCol = args.groupBy;
    const metrics = Array.isArray(args.metrics) && args.metrics.length > 0
      ? args.metrics
      : [{ column: ds.headers[0], agg: "count" as const, alias: "row_count" }];

    const groups = new Map<string, Record<string, string | number | null>[]>();
    for (const row of filtered) {
      const key = groupCol ? String(row[groupCol] ?? "(Missing)") : "All";
      const list = groups.get(key);
      if (list) list.push(row);
      else groups.set(key, [row]);
    }

    const resultRows: Record<string, string | number | null>[] = [];
    for (const [groupKey, groupRows] of groups.entries()) {
      const outRow: Record<string, string | number | null> = {};
      if (groupCol) outRow[groupCol] = groupKey;

      for (const m of metrics) {
        const alias = m.alias || `${m.agg}_${m.column}`;
        if (m.agg === "count") {
          outRow[alias] = groupRows.length;
          continue;
        }
        if (m.agg === "count_distinct") {
          const uniq = new Set(groupRows.map((r) => r[m.column]).filter((v) => v !== null && v !== ""));
          outRow[alias] = uniq.size;
          continue;
        }
        const nums = groupRows
          .map((r) => r[m.column])
          .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
        if (nums.length === 0) {
          outRow[alias] = 0;
          continue;
        }
        if (m.agg === "sum") {
          outRow[alias] = roundVal(nums.reduce((a, b) => a + b, 0));
        } else if (m.agg === "avg") {
          outRow[alias] = roundVal(nums.reduce((a, b) => a + b, 0) / nums.length);
        } else if (m.agg === "min") {
          outRow[alias] = roundVal(Math.min(...nums));
        } else if (m.agg === "max") {
          outRow[alias] = roundVal(Math.max(...nums));
        } else if (m.agg === "median") {
          const sorted = [...nums].sort((a, b) => a - b);
          const mid = Math.floor(sorted.length / 2);
          outRow[alias] = roundVal(
            sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid],
          );
        }
      }
      resultRows.push(outRow);
    }

    const sortKey = args.sortBy || (metrics[0]?.alias || `${metrics[0]?.agg}_${metrics[0]?.column}`);
    const order = args.sortOrder === "asc" ? 1 : -1;
    resultRows.sort((a, b) => {
      const va = a[sortKey];
      const vb = b[sortKey];
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * order;
      return String(va ?? "").localeCompare(String(vb ?? "")) * order;
    });

    return {
      dataset: ds.name,
      totalGroups: resultRows.length,
      matchedRows: filtered.length,
      rows: resultRows.slice(0, limit),
    };
  }

  if (args.operation === "outliers") {
    const targetCol =
      args.column && ds.headers.includes(args.column)
        ? args.column
        : ds.headers.find((h) => ds.columnTypes[h] === "number");
    if (!targetCol) return { error: "No numeric column found for outlier detection." };

    const entries = filtered
      .map((row, idx) => ({ row, idx, val: row[targetCol] }))
      .filter((e): e is { row: Record<string, string | number | null>; idx: number; val: number } =>
        typeof e.val === "number" && Number.isFinite(e.val),
      );

    if (entries.length < 4) {
      return { dataset: ds.name, column: targetCol, outlierCount: 0, outliers: [] };
    }

    const sorted = entries.map((e) => e.val).sort((a, b) => a - b);
    const q1 = sorted[Math.floor(sorted.length * 0.25)];
    const q3 = sorted[Math.floor(sorted.length * 0.75)];
    const iqr = q3 - q1;
    const lowerFence = q1 - 1.5 * iqr;
    const upperFence = q3 + 1.5 * iqr;

    const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    const std = Math.sqrt(sorted.reduce((a, v) => a + (v - mean) ** 2, 0) / sorted.length) || 1;

    const outliers = entries
      .filter((e) => e.val < lowerFence || e.val > upperFence)
      .sort((a, b) => Math.abs(b.val - mean) - Math.abs(a.val - mean))
      .slice(0, limit)
      .map((e) => ({
        rowIndex: e.idx + 1,
        value: roundVal(e.val),
        zScore: roundVal((e.val - mean) / std),
        record: e.row,
      }));

    return {
      dataset: ds.name,
      column: targetCol,
      q1: roundVal(q1),
      q3: roundVal(q3),
      iqr: roundVal(iqr),
      lowerFence: roundVal(lowerFence),
      upperFence: roundVal(upperFence),
      outlierCount: entries.filter((e) => e.val < lowerFence || e.val > upperFence).length,
      outliers,
    };
  }

  if (args.operation === "correlation") {
    const numCols = (
      Array.isArray(args.columns) && args.columns.length >= 2
        ? args.columns.filter((c) => ds.headers.includes(c))
        : ds.headers.filter((h) => ds.columnTypes[h] === "number")
    ).slice(0, 10);

    const pairs: Array<{ colA: string; colB: string; pearsonR: number; n: number }> = [];
    for (let i = 0; i < numCols.length; i++) {
      for (let j = i + 1; j < numCols.length; j++) {
        const aCol = numCols[i];
        const bCol = numCols[j];
        const xs: number[] = [];
        const ys: number[] = [];
        for (const r of filtered) {
          const va = r[aCol];
          const vb = r[bCol];
          if (typeof va === "number" && typeof vb === "number" && Number.isFinite(va) && Number.isFinite(vb)) {
            xs.push(va);
            ys.push(vb);
          }
        }
        if (xs.length < 3) continue;
        const meanX = xs.reduce((s, v) => s + v, 0) / xs.length;
        const meanY = ys.reduce((s, v) => s + v, 0) / ys.length;
        let num = 0;
        let denX = 0;
        let denY = 0;
        for (let k = 0; k < xs.length; k++) {
          const dx = xs[k] - meanX;
          const dy = ys[k] - meanY;
          num += dx * dy;
          denX += dx * dx;
          denY += dy * dy;
        }
        const denom = Math.sqrt(denX * denY);
        const rVal = denom > 0 ? roundVal(num / denom) : 0;
        pairs.push({ colA: aCol, colB: bCol, pearsonR: rVal, n: xs.length });
      }
    }

    pairs.sort((a, b) => Math.abs(b.pearsonR) - Math.abs(a.pearsonR));
    return { dataset: ds.name, pairs: pairs.slice(0, 20) };
  }

  // Default: filter_sort
  const sortedRows = [...filtered];
  if (args.sortBy && ds.headers.includes(args.sortBy)) {
    const key = args.sortBy;
    const order = args.sortOrder === "asc" ? 1 : -1;
    sortedRows.sort((a, b) => {
      const va = a[key];
      const vb = b[key];
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * order;
      return String(va ?? "").localeCompare(String(vb ?? "")) * order;
    });
  }

  return {
    dataset: ds.name,
    matchedRows: filtered.length,
    rows: sortedRows.slice(0, limit),
  };
}
