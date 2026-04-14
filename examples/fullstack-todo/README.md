# Fullstack Todo Skeleton

This example is the first checked-in fullstack skeleton that uses both Soundscript Wasm targets:

- [src/server.sts](./src/server.sts) is a real `wasm-node` SSR entry using real `express`, real `react-dom/server`, and real `react-router`.
- [src/client.sts](./src/client.sts) is a real `wasm-browser` root entry using real `react-dom/client` and real `react-router-dom`.
- [src/app.sts](./src/app.sts) is shared between both entries.

## Run It

1. Install the example packages:

```bash
cd examples/fullstack-todo
npm install
```

2. Compile and start the server:

```bash
deno run -A dev.ts
```

3. Open [http://localhost:4325/todos](http://localhost:4325/todos).

## Notes

- This is still a skeleton, not the final end-to-end app. The todo data is currently created inside Soundscript rather than loaded from a database.
- The browser entry now proves both `createRoot(...)` and `hydrateRoot(...)` on the same shared routed component path.
- The current todo flow is still in-memory. The next intended step is to swap that state path for Sequelize while keeping the same shared app surface.
