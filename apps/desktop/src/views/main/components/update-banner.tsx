import { useEffect, useState } from "react";
import { X, Download, CheckCircle, AlertCircle, Info } from "lucide-react";

type UpdateStatus = { status: string; message: string };

export function UpdateBanner({
  status,
  onDismiss,
}: {
  status: UpdateStatus;
  onDismiss: () => void;
}) {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (status.status !== "downloading") return;
    const interval = setInterval(() => {
      setProgress((p) => Math.min(p + 5, 95));
    }, 200);
    return () => clearInterval(interval);
  }, [status.status]);

  const { icon, colorClass, title } = resolveStatus(status);

  if (status.status === "about" || status.status === "activation-code") {
    return null;
  }

  return (
    <div className="absolute left-0 right-0 top-0 z-50 flex items-center gap-3 border-b border-white/[0.06] bg-[#111113] px-4 py-2.5">
      <span className={colorClass}>{icon}</span>
      <div className="flex-1">
        <div className="text-xs font-medium text-[#f2f2f2]">{title}</div>
        {status.message && (
          <div className="text-[11px] text-[#a0a0a0]">{status.message}</div>
        )}
        {status.status === "downloading" && (
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/[0.06]">
            <div
              className="h-full bg-[#22C55E] transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}
      </div>
      <button
        onClick={onDismiss}
        className="rounded p-1 text-[#737373] transition hover:bg-white/[0.06] hover:text-[#f2f2f2] active:scale-[0.96]"
      >
        <X size={14} />
      </button>
    </div>
  );
}

function resolveStatus(status: UpdateStatus) {
  switch (status.status) {
    case "update-available":
      return {
        icon: <Download size={16} />,
        colorClass: "text-[#22C55E]",
        title: "Update available",
      };
    case "downloading":
      return {
        icon: <Download size={16} />,
        colorClass: "text-[#22C55E]",
        title: "Downloading update…",
      };
    case "ready-to-install":
      return {
        icon: <CheckCircle size={16} />,
        colorClass: "text-[#22C55E]",
        title: "Update ready to install",
      };
    case "error":
      return {
        icon: <AlertCircle size={16} />,
        colorClass: "text-red-400",
        title: "Update error",
      };
    default:
      return {
        icon: <Info size={16} />,
        colorClass: "text-[#a0a0a0]",
        title: status.status,
      };
  }
}
