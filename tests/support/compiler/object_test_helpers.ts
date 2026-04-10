import { assertEquals, assertMatch, assertStringIncludes } from '@std/assert';

import { compileProject } from '../../../src/compiler/compile_project.ts';
import { createTempProject } from './test_helpers.ts';

export function assertWatDeclaresFallbackObjectType(watOutput: string): void {
  assertStringIncludes(watOutput, '(type $object_fallback');
}

export function assertWatCallsFallbackObjectGeneralize(watOutput: string): void {
  assertStringIncludes(watOutput, 'call $generalize_object_to_fallback');
}

export function assertWatCallsFallbackObjectGet(watOutput: string): void {
  assertStringIncludes(watOutput, 'call $get_fallback_object_property');
}

export function assertWatCallsFallbackObjectSet(watOutput: string): void {
  assertStringIncludes(watOutput, 'call $set_fallback_object_property');
}

export function assertWatCallsSpecializedObjectKeysListing(
  watOutput: string,
  propertyKeys: readonly string[],
): void {
  assertStringIncludes(watOutput, 'call $list_specialized_object_keys__');
  assertStringIncludes(watOutput, `Object.keys own-property order: ${propertyKeys.join(', ')}`);
}

export function assertWatUsesDistinctSpecializedObjectKeysHelperSymbols(watOutput: string): void {
  const helperNames = [
    ...watOutput.matchAll(/\$([A-Za-z0-9_]*list_specialized_object_keys__[A-Za-z0-9_]+)/g),
  ]
    .map((match) => match[1]);
  assertEquals(new Set(helperNames).size, 2);
}

export function assertWatCallsFallbackOrderedObjectKeysListing(watOutput: string): void {
  assertStringIncludes(watOutput, 'call $list_fallback_object_keys_in_js_own_property_order');
  assertStringIncludes(
    watOutput,
    'Object.keys own-property order contract: integer-index-like keys ascend numerically, then string keys keep insertion order.',
  );
}

export function assertWatCallsFallbackObjectHas(watOutput: string): void {
  assertStringIncludes(watOutput, 'call $has_fallback_object_property');
}

export function assertWatAvoidsFallbackObjectMembership(watOutput: string): void {
  assertEquals(watOutput.includes('call $generalize_object_to_fallback'), false);
  assertEquals(watOutput.includes('call $has_fallback_object_property'), false);
}

export function assertWatContainsWeightedHundredsTensOnesResult(watOutput: string): void {
  assertMatch(
    watOutput,
    /f64\.const 100[\s\S]*f64\.mul[\s\S]*f64\.const 10[\s\S]*f64\.mul[\s\S]*f64\.add[\s\S]*f64\.add/s,
  );
}

export function assertWatStaysOnSpecializedObjectLowering(watOutput: string): void {
  assertStringIncludes(watOutput, 'struct.new $object_shape_left_required_f64_right_required_f64');
  assertStringIncludes(
    watOutput,
    'struct.get $object_shape_left_required_f64_right_required_f64 1',
  );
  assertStringIncludes(
    watOutput,
    'struct.get $object_shape_left_required_f64_right_required_f64 0',
  );
}

export async function createCompilerTestProject(indexSource: string): Promise<string> {
  return await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
          },
          include: ['src/**/*.ts'],
        },
        null,
        2,
      ),
    },
    {
      path: 'src/index.ts',
      contents: indexSource,
    },
  ]);
}

export function compileTempProject(tempDirectory: string) {
  return compileProject({
    projectPath: `${tempDirectory}/tsconfig.json`,
    workingDirectory: tempDirectory,
  });
}
