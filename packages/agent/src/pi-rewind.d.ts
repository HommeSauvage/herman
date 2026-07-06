declare module "pi-rewind" {
  import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
  const factory: (pi: ExtensionAPI) => void;
  export default factory;
}
