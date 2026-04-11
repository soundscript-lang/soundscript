// Scaffold only: these microbenchmarks exist to keep future runtime-substrate
// evidence collection honest. They do not make any current performance claim.
// The second object variant is only an indirection placeholder today, not a
// real generalized/fallback runtime layout.

type FixedLayoutRecord = {
  a: number;
  b: number;
  c: number;
  d: number;
};

type IndirectionRecord = {
  slots: Record<string, number>;
};

const OBJECT_ACCESS_ITERATIONS = 100_000;
const DENSE_ARRAY_LENGTH = 256;
const DENSE_ARRAY_REPEATS = 512;

let sink = 0;

function buildFixedLayoutRecord(): FixedLayoutRecord {
  return { a: 1, b: 2, c: 3, d: 4 };
}

function buildIndirectionRecord(): IndirectionRecord {
  return { slots: { a: 1, b: 2, c: 3, d: 4 } };
}

function runFixedLayoutAccess(iterations: number): number {
  const record = buildFixedLayoutRecord();
  let total = 0;
  for (let i = 0; i < iterations; i += 1) {
    total += record.a + record.c;
  }
  return total;
}

function runIndirectionAccess(iterations: number): number {
  const record = buildIndirectionRecord();
  let total = 0;
  for (let i = 0; i < iterations; i += 1) {
    total += record.slots.a + record.slots.c;
  }
  return total;
}

function buildDenseArray(): number[] {
  return Array.from({ length: DENSE_ARRAY_LENGTH }, (_, index) => index);
}

function runDenseArrayPlaceholder(): number {
  const values = buildDenseArray();
  let total = 0;
  for (let repeat = 0; repeat < DENSE_ARRAY_REPEATS; repeat += 1) {
    for (const value of values) {
      total += value;
    }
  }
  return total;
}

Deno.bench("runtime substrate scaffold: fixed-layout object access", () => {
  sink = runFixedLayoutAccess(OBJECT_ACCESS_ITERATIONS);
});

Deno.bench("runtime substrate scaffold: object access with extra indirection", () => {
  sink = runIndirectionAccess(OBJECT_ACCESS_ITERATIONS);
});

Deno.bench("runtime substrate scaffold: dense-array operations placeholder", () => {
  sink = runDenseArrayPlaceholder();
});
