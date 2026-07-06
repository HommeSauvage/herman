# Herman

Herman is a desktop coding agent built with [Electrobun](https://electrobun.dev) and the
[pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) framework.

## Structure

```
apps/desktop     — Electrobun desktop app
packages/agent   — CLI agent binary
packages/rpc     — Shared protocol types
packages/ui      — shadcn/ui component library
tooling/tsconfig — Base TypeScript config
```

## Getting started

```bash
bun install
bun run dev
```

Requires Bun >= 1.3.

## License

MIT
