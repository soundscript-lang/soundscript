# Raw `test262` Cases

This directory is for JS-first automated raw imports from upstream `test262`.

- Prefer single-file `.js` fixtures.
- Prefer near-verbatim upstream files when `execution: "module"` is enough to express the case
  honestly.
- Use a directory with `raw.js` and `index.ts` only when a minimal typed adapter is required.
- Keep each fixture semantically direct to the upstream assertion recorded in the manifest provenance.
