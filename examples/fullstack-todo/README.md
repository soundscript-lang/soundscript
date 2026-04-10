# Fullstack Todo Skeleton

This example is the first checked-in fullstack skeleton that uses both Soundscript Wasm targets:

- [`src/server.sts`](./src/server.sts) is a real `wasm-node` SSR entry using real `express`, real
  `react-dom/server`, and real `react-router`.
- [`src/client.sts`](./src/client.sts) is a real `wasm-browser` root entry using real
  `react-dom/client` and real `react-router-dom`.
- [`src/app.sts`](./src/app.sts) is shared between both entries.

## Run It

1. Install the example packages:

```bash
npm install
```

2. Compile and start the server:

```bash
deno run -A dev.ts
```

3. Open [http://localhost:4325/todos](http://localhost:4325/todos).

## Notes

- This is still a skeleton, not the final end-to-end app. The todo data is currently created inside
  Soundscript rather than loaded from a database.
- The browser entry currently proves `createRoot(...)` plus shared routed component rendering. Full
  `hydrateRoot(...)` support on this real package path is still a separate gap.
- The next intended step is real browser-side mutation flow. The first attempt exposed two real
  generic gaps: JSX child-array export in SSR (`generic_owned_heap_array_to_host_array`) and
  callback-driven browser wrapper rendering on the `createRoot(...)` path.
- After those gaps are fixed, the next intended step is to swap the in-memory todo creation path for
  Sequelize.
