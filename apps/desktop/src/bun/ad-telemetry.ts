import { getLogger } from "@logtape/logtape";
import { reportWindowFocus } from "./herman-api.js";
import { loadState } from "./session.js";

const logger = getLogger(["herman-desktop", "ad-telemetry"]);

type VisibilityState = {
  focused: boolean;
  visible: boolean;
};

export class AdTelemetry {
  private state: VisibilityState = { focused: true, visible: true };
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private getFocused: () => boolean,
    private getVisible: () => boolean,
  ) {}

  update() {
    const focused = this.getFocused();
    const visible = this.getVisible();
    if (this.state.focused === focused && this.state.visible === visible) return;

    this.state = { focused, visible };

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      void this.sendFocusReport();
    }, 200);
  }

  getVisibility(): VisibilityState {
    return { ...this.state };
  }

  private async sendFocusReport() {
    const state = await loadState();
    if (!state.session) return;

    try {
      await reportWindowFocus(state.session.token, {
        focused: this.state.focused,
        visible: this.state.visible,
        timestamp: Date.now(),
      });
    } catch (error) {
      logger.debug("Window focus telemetry failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
