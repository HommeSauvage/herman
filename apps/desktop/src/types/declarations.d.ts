declare module "three";
declare module "@babylonjs/core";
declare module "*.css" {
  const content: string;
  export default content;
}

/** Electrobun nested OOPIF custom element (renderer). */
interface ElectrobunWebviewElement extends HTMLElement {
  src: string;
  html?: string;
  partition?: string;
  sandbox?: boolean;
  hidden?: boolean;
  passthroughEnabled?: boolean;
  webviewId?: number;
  maskSelectors?: Set<string>;

  reload(): void;
  loadURL(url: string): void;
  goBack(): void;
  goForward(): void;
  syncDimensions(force?: boolean): void;
  toggleHidden(value?: boolean): void;
  togglePassthrough(value?: boolean): void;
  toggleTransparent(value?: boolean): void;
  setNavigationRules(rules: string[]): void;
  executeJavascript(js: string): void;
  addMaskSelector(selector: string): void;
  removeMaskSelector(selector: string): void;
  on(event: string, listener: (event: CustomEvent) => void): void;
  off(event: string, listener: (event: CustomEvent) => void): void;
}

declare namespace React {
  namespace JSX {
    interface IntrinsicElements {
      "electrobun-webview": React.DetailedHTMLProps<
        React.HTMLAttributes<ElectrobunWebviewElement> & {
          src?: string;
          html?: string;
          partition?: string;
          sandbox?: boolean | string;
          masks?: string;
          hidden?: boolean;
          transparent?: boolean;
          renderer?: "native" | "cef";
        },
        ElectrobunWebviewElement
      >;
    }
  }
}
