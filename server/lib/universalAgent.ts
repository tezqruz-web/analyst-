import { GoogleGenAI, Type, type FunctionDeclaration } from "@google/genai";
import crypto from "crypto";
import type { AiProvider } from "./cloudflare.ts";
import { kvGet, kvPut } from "./cloudflare.ts";
import {
  renderSvgChartDataUri,
  type ChartDataPoint,
  type ChartType,
} from "./chartRenderer.ts";
import {
  executeDataQuery,
  loadDatasetsFromCsvFiles,
  profileDatasets,
  type DataQueryArgs,
  type LoadedDataset,
} from "./dataEngine.ts";

export interface UniversalAgentEvent {
  type:
    | "info"
    | "thinking"
    | "text"
    | "tool_call"
    | "tool_result"
    | "report_data"
    | "session"
    | "status"
    | "error";
  message?: string;
  text?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  result?: string;
  data?: Record<string, unknown>;
  environmentId?: string;
  status?: string;
}

interface SessionMemory {
  sessionId: string;
  clientId: string;
  datasetName: string;
  files: Array<{ name: string; content: string }>;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  updatedAt: number;
}

const sessionStore = new Map<string, SessionMemory>();

function saveSessionMemory(session: SessionMemory): void {
  sessionStore.set(session.sessionId, session);
  if (sessionStore.size > 200) {
    const oldest = sessionStore.keys().next().value;
    if (oldest) sessionStore.delete(oldest);
  }
  // Cache lightweight conversation metadata in Cloudflare KV if enabled
  kvPut(
    `agent_session:${session.clientId}:${session.sessionId}`,
    {
      sessionId: session.sessionId,
      datasetName: session.datasetName,
      history: session.history.slice(-12),
      fileNames: session.files.map((f) => f.name),
      updatedAt: session.updatedAt,
    },
    86400,
  ).catch(() => {});
}

export async function getSessionMemory(
  sessionId: string,
  clientId: string,
): Promise<SessionMemory | null> {
  const local = sessionStore.get(sessionId);
  if (local && local.clientId === clientId) {
    return local;
  }
  const kvCached = await kvGet<{
    sessionId: string;
    datasetName: string;
    history: Array<{ role: "user" | "assistant"; content: string }>;
    updatedAt: number;
  }>(`agent_session:${clientId}:${sessionId}`);
  if (kvCached) {
    const restored: SessionMemory = {
      sessionId,
      clientId,
      datasetName: kvCached.datasetName || "Workspace",
      files: [],
      history: Array.isArray(kvCached.history) ? kvCached.history : [],
      updatedAt: kvCached.updatedAt || Date.now(),
    };
    sessionStore.set(sessionId, restored);
    return restored;
  }
  return null;
}

export interface RunUniversalAgentParams {
  provider: AiProvider;
  model: string;
  apiKey: string;
  clientId: string;
  question: string;
  datasetName: string;
  files: Array<{ name: string; content?: string }>;
  sessionId?: string;
  signal?: AbortSignal;
  sendEvent: (ev: UniversalAgentEvent) => void;
}

interface GeneratedChartRecord {
  id: string;
  title: string;
  type: ChartType;
  caption: string;
  file: string;
  image: string;
}

interface ToolContext {
  datasets: LoadedDataset[];
  datasetName: string;
  question: string;
  charts: GeneratedChartRecord[];
  tables: Array<{
    title: string;
    columns: string[];
    rows: Array<Array<string | number | null>>;
    caption?: string;
  }>;
  report: Record<string, unknown> | null;
}

/* ────────────────────────────────────────────────────────── */
/*  Tool Definitions (shared across Google Gemini & DeepSeek)  */
/* ────────────────────────────────────────────────────────── */

const DEEPSEEK_TOOLS = [
  {
    type: "function",
    function: {
      name: "analyze_data",
      description:
        "Run deterministic analytics on loaded CSV/Excel datasets: group_aggregate, filter_sort, summary_stats, correlation, or outliers.",
      parameters: {
        type: "object",
        properties: {
          dataset: { type: "string", description: "Dataset filename (optional, defaults to first dataset)" },
          operation: {
            type: "string",
            enum: ["group_aggregate", "filter_sort", "outliers", "correlation", "summary_stats"],
          },
          groupBy: { type: "string", description: "Column name to group by (for group_aggregate)" },
          metrics: {
            type: "array",
            items: {
              type: "object",
              properties: {
                column: { type: "string" },
                agg: {
                  type: "string",
                  enum: ["sum", "avg", "min", "max", "count", "median", "count_distinct"],
                },
                alias: { type: "string" },
              },
              required: ["column", "agg"],
            },
          },
          filters: {
            type: "array",
            items: {
              type: "object",
              properties: {
                column: { type: "string" },
                op: { type: "string", enum: ["eq", "neq", "gt", "gte", "lt", "lte", "contains"] },
                value: { type: "string" },
              },
              required: ["column", "op", "value"],
            },
          },
          sortBy: { type: "string" },
          sortOrder: { type: "string", enum: ["asc", "desc"] },
          limit: { type: "number" },
          column: { type: "string", description: "Numeric column name for outliers" },
          columns: { type: "array", items: { type: "string" } },
        },
        required: ["operation"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_chart",
      description:
        "Render a publication-grade visual chart (bar, horizontal_bar, line, area, pie, scatter) to include in the interactive report dashboard.",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["bar", "horizontal_bar", "line", "area", "pie", "scatter"],
          },
          title: { type: "string" },
          caption: { type: "string" },
          xLabel: { type: "string" },
          yLabel: { type: "string" },
          data: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: { type: "string" },
                value: { type: "number" },
                x: { type: "number" },
              },
              required: ["label", "value"],
            },
          },
        },
        required: ["type", "title", "data"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "build_report",
      description:
        "Publish the final structured executive dashboard report (KPI insights, tables, charts, executive summary, recommendations) to the user interface.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          executive_summary: { type: "string" },
          insights: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                metric: { type: "string" },
                value: { type: "string" },
                detail: { type: "string" },
              },
              required: ["title", "detail"],
            },
          },
          tables: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                columns: { type: "array", items: { type: "string" } },
                rows: {
                  type: "array",
                  items: { type: "array", items: { type: "string" } },
                },
                caption: { type: "string" },
              },
              required: ["title", "columns", "rows"],
            },
          },
          methodology: { type: "string" },
          recommendations: { type: "array", items: { type: "string" } },
        },
        required: ["title", "executive_summary", "insights"],
      },
    },
  },
];

const GEMINI_FUNCTION_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: "analyze_data",
    description:
      "Run deterministic analytics on loaded CSV/Excel datasets: group_aggregate, filter_sort, summary_stats, correlation, or outliers.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        dataset: { type: Type.STRING, description: "Dataset filename (optional)" },
        operation: {
          type: Type.STRING,
          description: "One of: group_aggregate, filter_sort, outliers, correlation, summary_stats",
        },
        groupBy: { type: Type.STRING, description: "Column name to group by" },
        metrics: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              column: { type: Type.STRING },
              agg: { type: Type.STRING, description: "sum, avg, min, max, count, median, count_distinct" },
              alias: { type: Type.STRING },
            },
            required: ["column", "agg"],
          },
        },
        filters: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              column: { type: Type.STRING },
              op: { type: Type.STRING, description: "eq, neq, gt, gte, lt, lte, contains" },
              value: { type: Type.STRING },
            },
            required: ["column", "op", "value"],
          },
        },
        sortBy: { type: Type.STRING },
        sortOrder: { type: Type.STRING, description: "asc or desc" },
        limit: { type: Type.NUMBER },
        column: { type: Type.STRING },
        columns: { type: Type.ARRAY, items: { type: Type.STRING } },
      },
      required: ["operation"],
    },
  },
  {
    name: "create_chart",
    description:
      "Render a visual chart (bar, horizontal_bar, line, area, pie, scatter) to include in the interactive dashboard.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        type: { type: Type.STRING, description: "bar, horizontal_bar, line, area, pie, or scatter" },
        title: { type: Type.STRING },
        caption: { type: Type.STRING },
        xLabel: { type: Type.STRING },
        yLabel: { type: Type.STRING },
        data: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              label: { type: Type.STRING },
              value: { type: Type.NUMBER },
              x: { type: Type.NUMBER },
            },
            required: ["label", "value"],
          },
        },
      },
      required: ["type", "title", "data"],
    },
  },
  {
    name: "build_report",
    description:
      "Publish the final structured executive dashboard report (KPI insights, tables, charts, executive summary, recommendations) to the user interface.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING },
        executive_summary: { type: Type.STRING },
        insights: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              metric: { type: Type.STRING },
              value: { type: Type.STRING },
              detail: { type: Type.STRING },
            },
            required: ["title", "detail"],
          },
        },
        tables: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              columns: { type: Type.ARRAY, items: { type: Type.STRING } },
              rows: {
                type: Type.ARRAY,
                items: { type: Type.ARRAY, items: { type: Type.STRING } },
              },
              caption: { type: Type.STRING },
            },
            required: ["title", "columns", "rows"],
          },
        },
        methodology: { type: Type.STRING },
        recommendations: { type: Type.ARRAY, items: { type: Type.STRING } },
      },
      required: ["title", "executive_summary", "insights"],
    },
  },
];

function executeTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Record<string, unknown> {
  if (name === "analyze_data") {
    const result = executeDataQuery(ctx.datasets, args as unknown as DataQueryArgs);
    if (Array.isArray((result as any).rows) && (result as any).rows.length > 0) {
      const rowsObj = (result as any).rows as Record<string, string | number | null>[];
      const cols = Object.keys(rowsObj[0]);
      ctx.tables.push({
        title: String(args.groupBy ? `Breakdown by ${args.groupBy}` : `${args.operation} Results`),
        columns: cols,
        rows: rowsObj.slice(0, 25).map((r) => cols.map((c) => r[c] ?? null)),
        caption: `Computed from ${String((result as any).dataset || ctx.datasetName)}`,
      });
    }
    return result;
  }

  if (name === "create_chart") {
    const validTypes: ChartType[] = ["bar", "horizontal_bar", "line", "area", "pie", "scatter"];
    const rawType = String(args.type || "bar") as ChartType;
    const type: ChartType = validTypes.includes(rawType) ? rawType : "bar";
    const title = String(args.title || "Chart");
    const caption = String(args.caption || "");
    const rawData = Array.isArray(args.data) ? args.data : [];
    const data: ChartDataPoint[] = rawData
      .map((item: any) => ({
        label: String(item?.label ?? ""),
        value: Number(item?.value),
        x: item?.x !== undefined ? Number(item.x) : undefined,
      }))
      .filter((d) => Number.isFinite(d.value));

    const image = renderSvgChartDataUri({
      type,
      title,
      xLabel: typeof args.xLabel === "string" ? args.xLabel : undefined,
      yLabel: typeof args.yLabel === "string" ? args.yLabel : undefined,
      data,
    });

    const id = `chart_${ctx.charts.length + 1}.svg`;
    ctx.charts.push({
      id,
      title,
      type,
      caption,
      file: `charts/${id}`,
      image,
    });

    return {
      success: true,
      chartId: id,
      title,
      pointCount: data.length,
    };
  }

  if (name === "build_report") {
    const providedTables = Array.isArray(args.tables)
      ? (args.tables as Array<any>).map((t) => ({
          title: String(t?.title || "Data Table"),
          columns: Array.isArray(t?.columns) ? t.columns.map(String) : [],
          rows: Array.isArray(t?.rows) ? t.rows : [],
          caption: typeof t?.caption === "string" ? t.caption : undefined,
        }))
      : [];

    const finalTables = providedTables.length > 0 ? providedTables : ctx.tables;
    const insights = Array.isArray(args.insights)
      ? (args.insights as Array<any>).map((ins) => ({
          title: String(ins?.title || "Insight"),
          metric: typeof ins?.metric === "string" ? ins.metric : undefined,
          value: ins?.value !== undefined ? String(ins.value) : undefined,
          detail: String(ins?.detail || ""),
        }))
      : [];

    ctx.report = {
      dataset_name: ctx.datasetName || "AI Workspace",
      question: ctx.question,
      title: String(args.title || `Analysis: ${ctx.datasetName || "AI Report"}`),
      executive_summary: String(args.executive_summary || ""),
      insights,
      charts: ctx.charts.map((c) => ({
        title: c.title,
        file: c.file,
        caption: c.caption,
        type: c.type,
        image: c.image,
      })),
      tables: finalTables,
      methodology:
        typeof args.methodology === "string"
          ? args.methodology
          : ctx.datasets.length > 0
            ? "Autonomous multi-step profiling, deterministic aggregation, and chart synthesis."
            : "Autonomous AI reasoning and structured synthesis.",
      recommendations: Array.isArray(args.recommendations)
        ? args.recommendations.map(String)
        : [],
      generated_at: new Date().toISOString().split("T")[0],
    };

    return { success: true, status: "Report published to dashboard." };
  }

  return { error: `Unknown tool: ${name}` };
}

function buildSystemPrompt(hasFiles: boolean, provider: AiProvider, model: string): string {
  if (hasFiles) {
    return `You are an autonomous expert Data Analyst Agent running on ${provider.toUpperCase()} (${model}).
You have been given profiled CSV/Excel dataset(s) and real analytical tools:
1. \`analyze_data\` — run exact group aggregations, filtering, sorting, correlations, summary statistics, and IQR outlier detection. Never guess numbers; compute them with \`analyze_data\`.
2. \`create_chart\` — render 1 to 3 clean visual charts (bar, horizontal_bar, line, area, pie, scatter) using exact computed values.
3. \`build_report\` — publish the structured dashboard report (title, executive_summary, 3-4 KPI insights with metric/value/detail, structured tables, methodology, recommendations).

WORKFLOW:
- First run 1-3 targeted \`analyze_data\` calls to answer the user's question with exact numbers.
- Then call \`create_chart\` for the most insightful 1-3 charts.
- Then call \`build_report\` to publish the complete interactive dashboard.
- Finally, reply in the SAME language the user asked in (e.g., Uzbek, English, Russian, etc.) with a concise, clear executive summary of your findings.`;
  }

  return `You are an autonomous AI Data & Strategy Agent running on ${provider.toUpperCase()} (${model}).
The user did NOT upload a CSV/Excel file — they are asking you directly as an AI agent.
- Answer in the SAME language as the user's question (e.g., Uzbek, English, Russian, etc.).
- You can answer general questions, write SQL/Python/Excel formulas, perform calculations, design architectures, or build executive briefs.
- Whenever the question involves comparisons, structured breakdowns, forecasts, quantitative estimates, tables, or reports, you MAY call \`create_chart\` and \`build_report\` to populate the interactive visual dashboard alongside your chat answer.
- For every turn, call \`build_report\` if you created charts or structured tables, OR even for rich advisory questions to give the user a clean executive summary card with key takeaways and actionable recommendations.`;
}

function synthesizeFallbackReport(ctx: ToolContext, assistantText: string, provider: AiProvider, model: string) {
  const cleanSummary =
    assistantText.trim() || "The agent completed processing your request.";
  const shortSummary =
    cleanSummary.length > 1400 ? `${cleanSummary.slice(0, 1400)}...` : cleanSummary;

  const insights =
    ctx.datasets.length > 0
      ? ctx.datasets.slice(0, 4).map((ds) => ({
          title: ds.name,
          metric: "Dataset Rows",
          value: ds.rows.length.toLocaleString("en-US"),
          detail: `${ds.headers.length} columns analyzed using ${provider.toUpperCase()} (${model}).`,
        }))
      : [
          {
            title: "AI Agent Engine",
            metric: "Active Model",
            value: model,
            detail: `Answered directly in agent mode via ${provider === "deepseek" ? "DeepSeek" : "Google Gemini"}.`,
          },
        ];

  return {
    dataset_name: ctx.datasetName || (ctx.datasets.length > 0 ? ctx.datasets[0].name : "AI Agent"),
    question: ctx.question,
    title: ctx.datasets.length > 0 ? `Analysis: ${ctx.datasetName}` : "AI Agent Brief",
    executive_summary: shortSummary,
    insights,
    charts: ctx.charts.map((c) => ({
      title: c.title,
      file: c.file,
      caption: c.caption,
      type: c.type,
      image: c.image,
    })),
    tables: ctx.tables,
    methodology: `Generated autonomously using ${provider === "deepseek" ? "DeepSeek" : "Google Gemini"} (${model}).`,
    recommendations: [],
    generated_at: new Date().toISOString().split("T")[0],
  };
}

/* ────────────────────────────────────────────────────────── */
/*  Google Gemini Runner (@google/genai)                       */
/* ────────────────────────────────────────────────────────── */

async function runWithGoogleGemini(
  params: RunUniversalAgentParams,
  ctx: ToolContext,
  systemInstruction: string,
  userPrompt: string,
  history: Array<{ role: "user" | "assistant"; content: string }>,
): Promise<string> {
  const ai = new GoogleGenAI({
    apiKey: params.apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });

  const activeTools =
    ctx.datasets.length > 0
      ? GEMINI_FUNCTION_DECLARATIONS
      : GEMINI_FUNCTION_DECLARATIONS.filter((t) => t.name !== "analyze_data");

  const contents: any[] = [];
  for (const h of history.slice(-8)) {
    contents.push({
      role: h.role === "assistant" ? "model" : "user",
      parts: [{ text: h.content }],
    });
  }
  contents.push({ role: "user", parts: [{ text: userPrompt }] });

  let finalText = "";
  const maxSteps = 7;

  for (let step = 0; step < maxSteps; step++) {
    if (params.signal?.aborted) throw new DOMException("Aborted", "AbortError");

    const response = await ai.models.generateContent({
      model: params.model,
      contents,
      config: {
        systemInstruction,
        tools: [{ functionDeclarations: activeTools }],
      },
    });

    const candidate = response.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];

    const functionCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    for (const part of parts as any[]) {
      if (part.thought && typeof part.text === "string" && part.text) {
        params.sendEvent({ type: "thinking", text: part.text });
      } else if (part.functionCall) {
        functionCalls.push({
          name: String(part.functionCall.name),
          args: (part.functionCall.args as Record<string, unknown>) || {},
        });
      } else if (typeof part.text === "string" && part.text) {
        finalText += (finalText ? "\n" : "") + part.text;
        params.sendEvent({ type: "text", text: part.text });
      }
    }

    if (functionCalls.length === 0) {
      break;
    }

    contents.push({ role: "model", parts });

    const responseParts: any[] = [];
    for (const call of functionCalls) {
      params.sendEvent({
        type: "tool_call",
        name: call.name,
        arguments: call.args,
      });

      const resultObj = executeTool(call.name, call.args, ctx);
      const resultStr = JSON.stringify(resultObj);
      params.sendEvent({
        type: "tool_result",
        name: call.name,
        result: resultStr.length > 2500 ? `${resultStr.slice(0, 2500)}…` : resultStr,
      });

      responseParts.push({
        functionResponse: {
          name: call.name,
          response: resultObj,
        },
      });
    }

    contents.push({ role: "user", parts: responseParts });
  }

  return finalText;
}

/* ────────────────────────────────────────────────────────── */
/*  DeepSeek Runner (OpenAI-Compatible Chat Completions API)   */
/* ────────────────────────────────────────────────────────── */

async function callDeepSeekApi(
  apiKey: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<any> {
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    let msg = `DeepSeek API error (${response.status})`;
    try {
      const parsed = JSON.parse(errText);
      if (parsed?.error?.message) msg = `DeepSeek API: ${parsed.error.message}`;
    } catch {
      if (errText) msg = `DeepSeek API (${response.status}): ${errText.slice(0, 250)}`;
    }
    throw new Error(msg);
  }

  return response.json();
}

async function runWithDeepSeek(
  params: RunUniversalAgentParams,
  ctx: ToolContext,
  systemInstruction: string,
  userPrompt: string,
  history: Array<{ role: "user" | "assistant"; content: string }>,
): Promise<string> {
  const activeTools =
    ctx.datasets.length > 0
      ? DEEPSEEK_TOOLS
      : DEEPSEEK_TOOLS.filter((t) => t.function.name !== "analyze_data");

  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: systemInstruction },
    ...history.slice(-8).map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: userPrompt },
  ];

  let finalText = "";
  const maxSteps = 7;

  for (let step = 0; step < maxSteps; step++) {
    if (params.signal?.aborted) throw new DOMException("Aborted", "AbortError");

    const payload: Record<string, unknown> = {
      model: params.model,
      messages,
      tools: activeTools,
      tool_choice: "auto",
    };

    let data: any;
    try {
      data = await callDeepSeekApi(params.apiKey, payload, params.signal);
    } catch (err: any) {
      // Fallback if a DeepSeek reasoning endpoint rejects tool definitions
      if (step === 0 && /tool|function/i.test(String(err?.message || ""))) {
        const plainPayload: Record<string, unknown> = {
          model: params.model,
          messages,
        };
        data = await callDeepSeekApi(params.apiKey, plainPayload, params.signal);
      } else {
        throw err;
      }
    }

    const msg = data?.choices?.[0]?.message;
    if (!msg) break;

    if (typeof msg.reasoning_content === "string" && msg.reasoning_content.trim()) {
      params.sendEvent({ type: "thinking", text: msg.reasoning_content });
    }

    if (typeof msg.content === "string" && msg.content.trim()) {
      finalText += (finalText ? "\n" : "") + msg.content;
      params.sendEvent({ type: "text", text: msg.content });
    }

    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (toolCalls.length === 0) {
      break;
    }

    const assistantTurn: Record<string, unknown> = {
      role: "assistant",
      content: msg.content ?? "",
      tool_calls: toolCalls,
    };
    if (typeof msg.reasoning_content === "string") {
      assistantTurn.reasoning_content = msg.reasoning_content;
    }
    messages.push(assistantTurn);

    for (const tc of toolCalls) {
      const fnName = String(tc?.function?.name || "");
      let fnArgs: Record<string, unknown> = {};
      try {
        fnArgs =
          typeof tc?.function?.arguments === "string"
            ? JSON.parse(tc.function.arguments || "{}")
            : (tc?.function?.arguments as Record<string, unknown>) || {};
      } catch {
        fnArgs = {};
      }

      params.sendEvent({
        type: "tool_call",
        name: fnName,
        arguments: fnArgs,
      });

      const resultObj = executeTool(fnName, fnArgs, ctx);
      const resultStr = JSON.stringify(resultObj);

      params.sendEvent({
        type: "tool_result",
        name: fnName,
        result: resultStr.length > 2500 ? `${resultStr.slice(0, 2500)}…` : resultStr,
      });

      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: resultStr,
      });
    }
  }

  return finalText;
}

/* ────────────────────────────────────────────────────────── */
/*  Public Entry Point                                         */
/* ────────────────────────────────────────────────────────── */

export async function runUniversalAgent(params: RunUniversalAgentParams): Promise<void> {
  const { provider, model, clientId, question, sendEvent } = params;

  const existingSession = params.sessionId
    ? await getSessionMemory(params.sessionId, clientId)
    : null;

  const sessionId =
    existingSession?.sessionId || `ua_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;

  const incomingFiles = params.files
    .filter((f): f is { name: string; content: string } => Boolean(f.name && f.content))
    .map((f) => ({ name: f.name, content: f.content }));

  const effectiveFiles =
    incomingFiles.length > 0 ? incomingFiles : existingSession?.files ?? [];

  const effectiveDatasetName =
    params.datasetName && params.datasetName !== "Dataset"
      ? params.datasetName
      : existingSession?.datasetName ||
        (effectiveFiles.length > 0 ? effectiveFiles[0].name.replace(/\.csv$/i, "") : "AI Agent");

  sendEvent({ type: "session", environmentId: sessionId });
  sendEvent({
    type: "info",
    message:
      effectiveFiles.length > 0
        ? `Running ${provider === "deepseek" ? "DeepSeek" : "Google Gemini"} (${model}) on ${effectiveFiles.length} dataset(s)...`
        : `Running ${provider === "deepseek" ? "DeepSeek" : "Google Gemini"} (${model}) agent...`,
  });

  const datasets = loadDatasetsFromCsvFiles(effectiveFiles);
  const ctx: ToolContext = {
    datasets,
    datasetName: effectiveDatasetName,
    question,
    charts: [],
    tables: [],
    report: null,
  };

  let userPrompt = question;
  if (datasets.length > 0) {
    sendEvent({
      type: "tool_call",
      name: "profile_datasets",
      arguments: { datasets: datasets.map((d) => d.name) },
    });
    const profiles = profileDatasets(datasets);
    const profileJson = JSON.stringify(profiles);
    sendEvent({
      type: "tool_result",
      name: "profile_datasets",
      result: profileJson.length > 2200 ? `${profileJson.slice(0, 2200)}…` : profileJson,
    });

    const trimmedProfile =
      profileJson.length > 18000 ? `${profileJson.slice(0, 18000)}... [truncated]` : profileJson;
    userPrompt = `LOADED DATASETS PROFILE:\n${trimmedProfile}\n\nUSER QUESTION:\n${question}`;
  }

  const systemInstruction = buildSystemPrompt(datasets.length > 0, provider, model);
  const history = existingSession?.history ?? [];

  const finalText =
    provider === "deepseek"
      ? await runWithDeepSeek(params, ctx, systemInstruction, userPrompt, history)
      : await runWithGoogleGemini(params, ctx, systemInstruction, userPrompt, history);

  const report =
    ctx.report ?? synthesizeFallbackReport(ctx, finalText, provider, model);

  if (!finalText.trim() && typeof report.executive_summary === "string") {
    sendEvent({ type: "text", text: report.executive_summary });
  }

  sendEvent({ type: "report_data", data: report });
  sendEvent({ type: "status", status: "completed" });

  const nextHistory = [
    ...history,
    { role: "user" as const, content: question },
    {
      role: "assistant" as const,
      content: finalText.trim() || String(report.executive_summary || "Analysis completed."),
    },
  ].slice(-16);

  saveSessionMemory({
    sessionId,
    clientId,
    datasetName: effectiveDatasetName,
    files: effectiveFiles,
    history: nextHistory,
    updatedAt: Date.now(),
  });
}
