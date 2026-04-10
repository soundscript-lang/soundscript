import { assert, assertEquals } from '@std/assert';

import { runInlineFixture } from '../support/harness.ts';

interface FuzzCase {
  name: string;
  source: string;
  wave: string;
  expectedSoundCode?: string;
  expectedExitCode?: number;
}

type BroadCorpusKind = 'assertion' | 'dts-import' | 'flow' | 'type-guard' | 'variance';
type CurrentRuleKind = 'any' | 'assertion' | 'nonnull' | 'trusted-assertion';

function createPrng(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state += 0x6d2b79f5;
    let next = state;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<TValue>(random: () => number, values: readonly TValue[]): TValue {
  return values[Math.floor(random() * values.length)] ?? values[0];
}

function createSyntaxFuzzCases(): readonly FuzzCase[] {
  return Array.from({ length: 12 }, (_unused, index) => {
    const seed = index + 1;
    const random = createPrng(seed);
    const variableName = pick(random, ['alpha', 'beta', 'gamma', 'delta']);
    const literal = pick(random, ['1', '2', '3', '4']);
    const template = pick<CurrentRuleKind>(
      random,
      ['any', 'assertion', 'nonnull', 'trusted-assertion'],
    );

    switch (template) {
      case 'any':
        return {
          name: `syntax-any-seed-${seed}`,
          wave: 'fuzz-current-rules',
          expectedSoundCode: 'SOUND1001',
          expectedExitCode: 1,
          source: `// @sound-test: reject
const ${variableName}: any = ${literal};
export const observed = ${variableName};
`,
        };
      case 'assertion':
        return {
          name: `syntax-assertion-seed-${seed}`,
          wave: 'fuzz-current-rules',
          expectedSoundCode: 'SOUND1002',
          expectedExitCode: 1,
          source: `// @sound-test: reject
const ${variableName}: unknown = '${variableName}';
export const observed = ${variableName} as number;
`,
        };
      case 'nonnull':
        return {
          name: `syntax-nonnull-seed-${seed}`,
          wave: 'fuzz-current-rules',
          expectedSoundCode: 'SOUND1003',
          expectedExitCode: 1,
          source: `// @sound-test: reject
declare const ${variableName}: string | undefined;
export const observed = ${variableName}!;
`,
        };
      case 'trusted-assertion':
        return {
          name: `syntax-trusted-assertion-seed-${seed}`,
          wave: 'fuzz-current-rules',
          expectedExitCode: 0,
          source: `// @sound-test: accept
const ${variableName} = ${literal} as const;
// #[unsafe]
export const observed = ${variableName} as number;
`,
        };
      default: {
        const exhaustiveCheck: never = template;
        return exhaustiveCheck;
      }
    }
  });
}

function createBroadCorpusCases(): readonly FuzzCase[] {
  return Array.from({ length: 24 }, (_unused, index) => {
    const seed = index + 101;
    const random = createPrng(seed);
    const typeName = pick(random, ['Box', 'Shape', 'Packet', 'Entry']);
    const propertyName = pick(random, ['value', 'kind', 'payload', 'tag']);
    const corpusKind = pick<BroadCorpusKind>(random, [
      'flow',
      'variance',
      'type-guard',
      'assertion',
      'dts-import',
    ]);

    switch (corpusKind) {
      case 'flow':
        return {
          name: `broad-flow-seed-${seed}`,
          wave: 'fuzz-broad-corpus',
          source: `// @sound-test: reject
interface ${typeName} {
  ${propertyName}: string | number;
}

let shared: ${typeName} | undefined;

async function mutate(): Promise<void> {
  if (shared) {
    shared.${propertyName} = 42;
  }
}

export async function run(item: ${typeName}): Promise<void> {
  shared = item;
  if (typeof item.${propertyName} === 'string') {
    await mutate();
    item.${propertyName}.toUpperCase();
  }
}
`,
        };
      case 'variance':
        return {
          name: `broad-variance-seed-${seed}`,
          wave: 'fuzz-broad-corpus',
          source: `// @sound-test: reject
const narrow: string[] = ['${typeName.toLowerCase()}'];
const wide: object[] = narrow;
wide[0] = 42;
export const observed = narrow[0];
`,
        };
      case 'type-guard':
        return {
          name: `broad-type-guard-seed-${seed}`,
          wave: 'fuzz-broad-corpus',
          source: `// @sound-test: reject
interface ${typeName} {
  ${propertyName}: string;
}

export function is${typeName}(value: unknown): value is ${typeName} {
  return typeof value === 'object' && value !== null && '${propertyName}' in value;
}
`,
        };
      case 'assertion':
        return {
          name: `broad-assertion-seed-${seed}`,
          wave: 'fuzz-broad-corpus',
          source: `// @sound-test: accept
export function assert${typeName}(value: unknown): asserts value is string {
  if (typeof value !== 'string') {
    throw new Error('${typeName}');
  }
}
`,
        };
      case 'dts-import':
        return {
          name: `broad-dts-import-seed-${seed}`,
          wave: 'fuzz-broad-corpus',
          source: `// @sound-test: reject
// @sound-lib: dts
import { unsafeValue } from "../../test/lib";

export const observed = unsafeValue;
`,
        };
      default: {
        const exhaustiveCheck: never = corpusKind;
        return exhaustiveCheck;
      }
    }
  });
}

for (const fuzzCase of createSyntaxFuzzCases()) {
  Deno.test(`fuzz/current-rules/${fuzzCase.name}`, async () => {
    const run = await runInlineFixture({
      name: fuzzCase.name,
      source: fuzzCase.source,
      suite: `fuzz/current-rules/${fuzzCase.wave}`,
    });

    if (fuzzCase.expectedSoundCode) {
      assert(
        run.soundCodes.includes(fuzzCase.expectedSoundCode),
        `expected ${fuzzCase.expectedSoundCode} in ${fuzzCase.name}, got ${
          run.soundCodes.join(', ')
        }`,
      );
    } else {
      assertEquals(run.soundCodes, [], `expected no sound diagnostics in ${fuzzCase.name}`);
    }

    if (fuzzCase.expectedExitCode !== undefined) {
      assertEquals(run.result.exitCode, fuzzCase.expectedExitCode, run.result.output);
    }
  });
}

Deno.test('fuzz/broad-corpus programs do not crash the CLI driver', async () => {
  for (const fuzzCase of createBroadCorpusCases()) {
    const run = await runInlineFixture({
      name: fuzzCase.name,
      source: fuzzCase.source,
      suite: `fuzz/broad-corpus/${fuzzCase.wave}`,
    });

    assert(typeof run.result.output === 'string', `expected string output for ${fuzzCase.name}`);
    assert(
      Array.isArray(run.result.diagnostics),
      `expected diagnostics array for ${fuzzCase.name}`,
    );
  }
});
