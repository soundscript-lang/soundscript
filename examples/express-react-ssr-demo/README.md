# Express React SSR Demo

This example is a real Soundscript `wasm-node` app. The `.sts` entry imports real `express`, real `react-dom/server`, and real `react-router`, renders a routed React tree to HTML on the server, and serves it from an Express route.

## Run It

1. Install the example packages:

```bash
cd /Users/jakemccloskey/repos/soundscript-lang/soundscript/examples/express-react-ssr-demo
npm install
```

2. Compile and start the server:

```bash
deno run -A dev.ts
```

3. Open [http://localhost:4324/todos](http://localhost:4324/todos).

## Notes

- The server entry lives in [src/server.sts](/Users/jakemccloskey/repos/soundscript-lang/soundscript/examples/express-react-ssr-demo/src/server.sts).
- The current demo renders `/todos` through `StaticRouter`, `Routes`, and `Route` before calling `renderToString`.
- The example currently keeps a small local `MinimalApp` facade in [src/express-types.d.ts](/Users/jakemccloskey/repos/soundscript-lang/soundscript/examples/express-react-ssr-demo/src/express-types.d.ts) so the checked-in demo stays on the already-proven interop surface while still using the real `express` package.
- `dev.ts` compiles the Soundscript project, instantiates the generated wrapper, and calls the exported Wasm `start()` function once.
