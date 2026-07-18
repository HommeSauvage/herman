import type { ElectrobunConfig } from "electrobun";

const isDev = Boolean(process.env.HERMAN_DESKTOP_DEV_URL);

const copy: Record<string, string> = {
  "../../packages/agent/dist": "packages/agent/dist",
  "templates": "templates",
  "rookie-docs": "rookie-docs",
  "src/bun/wizard-extension": "wizard-extension",
};

if (!isDev) {
  copy["dist/renderer"] = "views/main";
}

export default {
  app: {
    name: "Herman",
    identifier: "sh.clique.herman",
    version: "0.0.1",
    description: "Desktop display and authentication app for Herman",
  },
  runtime: {
    exitOnLastWindowClosed: true,
  },
  build: {
    bun: {
      entrypoint: "src/bun/index.ts",
    },
    views: {},
    copy,
    watchIgnore: isDev ? ["dist/renderer"] : undefined,
    mac: {
      createDmg: false,
      codesign: false,
      notarize: false,
      icons: "assets/icon.iconset",
    },
    win: {
      icon: "assets/icon.png",
    },
    linux: {
      icon: "assets/icon.png",
    },
  },
  scripts: {
    preBuild: "scripts/prebuild.ts",
  },
  release: {
    baseUrl: process.env.HERMAN_DESKTOP_UPDATE_BASE_URL ?? "",
    generatePatch: true,
  },
} satisfies ElectrobunConfig;
