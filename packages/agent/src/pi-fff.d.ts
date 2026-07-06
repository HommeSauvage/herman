declare module "@bacnh85/pi-fff" {
  import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
  const factory: (pi: ExtensionAPI) => void;
  export default factory;
}
