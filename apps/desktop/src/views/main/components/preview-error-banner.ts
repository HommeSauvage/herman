export type PreviewRuntimeError = {
  id: string;
  source: "client" | "server";
  message: string;
  ts: number;
};
