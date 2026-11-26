export type AiProvider = 'google' | 'deepseek';

export interface CloudflareStatus {
  d1: boolean;
  kv: boolean;
  r2: boolean;
  encryptionConfigured: boolean;
}

export interface ProviderSettings {
  provider: AiProvider;
  model: string;
  hasGoogleKey: boolean;
  googleKeyHint: string | null;
  hasDeepseekKey: boolean;
  deepseekKeyHint: string | null;
  storage: CloudflareStatus;
}

export interface ReportInsight {
  title: string;
  detail: string;
  metric?: string;
  value?: string;
}

export interface ReportChart {
  title: string;
  file: string;
  caption?: string;
  type?: string;
  /** Base64 data URL or server URL for the rendered chart image. */
  image?: string;
}

export interface ReportTable {
  title: string;
  columns: string[];
  rows: Array<Array<string | number | null>>;
  caption?: string;
}

export interface AnalysisReport {
  dataset_name: string;
  question: string;
  title: string;
  executive_summary: string;
  insights: ReportInsight[];
  charts: ReportChart[];
  tables: ReportTable[];
  methodology?: string;
  recommendations?: string[];
  generated_at?: string;
}

export type ActivityType =
  | 'info'
  | 'thinking'
  | 'text'
  | 'tool_call'
  | 'tool_result'
  | 'error';

export interface ActivityLog {
  id: string;
  timestamp: string;
  type: ActivityType;
  content?: string;
  name?: string;
  args?: Record<string, unknown>;
  result?: string;
}

export interface UploadedFile {
  name: string;
  originalName?: string;
  sheetName?: string;
  content?: string;
  gsUri?: string;
  r2Key?: string;
  localPath?: string;
  isLocal?: boolean;
  isGcsUri?: boolean;
  size?: number;
  rowCount?: number;
  columnCount?: number;
  fileType?: 'csv' | 'excel';
  driveId?: string;
  mimeType?: string;
}

declare global {
  interface Window {
    gapi: any;
    google?: any;
  }
  const google: any;
}
