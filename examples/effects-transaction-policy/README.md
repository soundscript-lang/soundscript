Checked-in effect policy example for transaction boundaries.

This example shows one practical policy pattern with the open dotted effect surface:

- database queries are allowed inside a transaction callback
- ordinary host I/O is forbidden inside that same callback

The important modeling choice is the effect taxonomy:

- database queries use `host.db.query`
- generic file or network I/O uses `host.io`

That matters because `forbid` is subtractive only. There is no "forbid `host.*` except
`host.db.query`" surface. If you want queries to stay allowed while generic I/O is forbidden, the
allowed effect must not live under the forbidden prefix.

## Files

- `src/index.sts` contains the runnable example surface
- `tsconfig.json` keeps the example self-contained for analyzer tests

## What To Try

The exported `transferFunds(...)` function is accepted because the transaction body only performs
`host.db.query` operations.

To see the policy fail, uncomment the `readTextFile(...)` line inside the transaction callback. That
call adds `host.io`, so the parameter-local `#[effects(forbid: [host.io])]` contract on
`inTransaction(...)` rejects it.
