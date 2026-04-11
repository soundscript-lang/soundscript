# Express React SSR Demo

This example now has both server and browser entries around one shared Soundscript route tree.

- The server entry is a real `wasm-node` app using real `express`, real `react-dom/server`, and real `react-router`.
- The browser entry is a real `wasm-browser` app using real `react-dom/client` and real `react-router-dom`.
- Both entries import the same routed component tree from [src/app.sts](./src/app.sts).

## Run It

1. Install the example packages:

```bash
cd examples/express-react-ssr-demo
npm install
```

2. Compile and start the server:

```bash
deno run -A dev.ts
```

3. Open [http://localhost:4324/todos](http://localhost:4324/todos).

## Browser Entry

The browser client lives in [src/client.sts](./src/client.sts) and compiles with [browser.tsconfig.json](./browser.tsconfig.json). It uses real `react-router-dom` and `react-dom/client` against the same [src/app.sts](./src/app.sts) route tree as the server.

## Notes

- The server entry lives in [src/server.sts](./src/server.sts).
- The shared route tree lives in [src/app.sts](./src/app.sts).
- The current demo renders `/todos` through `StaticRouter` before calling `renderToString`, and the browser entry renders the same tree through `HashRouter`.
- The shared route tree currently sticks to `Route` `element` props, which keeps the example on the already-proven generic object/array boundary path.
- The checked-in browser runtime smoke currently proves `react-dom/client` root creation and shared-route mounting, but it does not yet re-enter the returned `AppRoutes` component on the host side. Exporting imported host callables from broad nested React element fields is still an open generic interop gap.
- The example currently keeps a small local `MinimalApp` facade in [src/express-types.d.ts](./src/express-types.d.ts) so the checked-in demo stays on the already-proven interop surface while still using the real `express` package.
- `dev.ts` compiles the Soundscript project, instantiates the generated wrapper, and calls the exported Wasm `start()` function once.
