# React Browser Demo

This example is an actual Soundscript `wasm-browser` app. The `.sts` file uses real JSX syntax,
imports real `react-dom/client`, creates a React root inside Wasm, and keeps its click count in
module-level Wasm state. Plain browser JavaScript only instantiates the generated wrapper and calls
`start()`.

## Run It

1. Install the example packages:

```bash
npm install
```

2. Compile and serve the example:

```bash
deno run -A dev.ts
```

3. Open [http://localhost:4313](http://localhost:4313).

The React root and the rendered button both live in [`src/app.sts`](./src/app.sts). The `.sts`
module imports `document` through `host:dom`, calls real `createRoot(...)` from `react-dom/client`,
and rerenders itself from a Wasm-authored `onClick` callback.
[`src/bootstrap.js`](./src/bootstrap.js) just loads the wrapper and calls `start()`.

## Notes

- `index.html` uses an import map so the browser can resolve bare package specifiers like
  `react/jsx-runtime` and `react-dom/client`.
- `dev.ts` recompiles the Soundscript project on startup, then serves the example directory as a
  static site.
- The compiler now lowers JSX in `.sts` files to `react/jsx-runtime` imports during source
  preparation, so the checked-in example stays in JSX instead of manual `jsx(...)` calls.
- The DOM event is no longer injected by the host bootstrap. React calls the Wasm-authored `onClick`
  prop directly.
- The current click count and the React root now both live in module-level `.sts` state.
