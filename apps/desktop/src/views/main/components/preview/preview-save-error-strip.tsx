import { PreviewErrorBox } from "./preview-error-box.js";

type PreviewSaveErrorStripProps = {
  error: string;
  onAskFix: () => void;
  askDisabled: boolean;
};

export function PreviewSaveErrorStrip({ error, onAskFix, askDisabled }: PreviewSaveErrorStripProps) {
  return (
    <div className="shrink-0 border-b border-mist bg-fog px-3 py-2">
      <PreviewErrorBox
        title="Could not save changes"
        subtitle="Your draft could not be applied to the project."
        error={error}
        onAsk={onAskFix}
        disabled={askDisabled}
      />
    </div>
  );
}
