import type { AdClickReport, AdImpressionReport } from "./ads.js";

export type JSONLRequest<T = unknown> = {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: T;
};

export type JSONLNotification<T = unknown> = {
  jsonrpc: "2.0";
  method: string;
  params?: T;
};

export type JSONLResponse<T = unknown> = {
  jsonrpc: "2.0";
  id: string | number;
  result: T;
};

export type JSONLError = {
  jsonrpc: "2.0";
  id?: string | number;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
};

export type AgentMethod =
  | "initialize"
  | "chat"
  | "applyEdit"
  | "runCommand"
  | "readFile"
  | "writeFile"
  | "search"
  | "terminal";

export type HermanNotification =
  | { method: "herman/adImpression"; params: AdImpressionReport }
  | { method: "herman/adClick"; params: AdClickReport }
  | { method: "herman/windowFocus"; params: { focused: boolean } }
  | { method: "herman/windowVisibility"; params: { visible: boolean } };
