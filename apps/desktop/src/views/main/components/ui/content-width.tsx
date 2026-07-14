import { cn } from "@herman/ui/lib/utils";
import type { ReactNode } from "react";

const SIZE_CLASS = {
  page: "max-w-5xl",
  chat: "max-w-3xl",
  settings: "max-w-2xl",
  form: "max-w-md",
  formWide: "max-w-lg",
} as const;

export type ContentWidthSize = keyof typeof SIZE_CLASS;

/** Named content max-width. Do not invent a third ad-hoc max-w for page chrome. */
export function ContentWidth({
  size = "page",
  children,
  className,
}: {
  size?: ContentWidthSize;
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn("mx-auto w-full", SIZE_CLASS[size], className)}>{children}</div>;
}
