import { assertEquals } from '@std/assert';
import { join } from '@std/path';

import { packageCompilerOutput } from './toolchain.ts';

for (const runtimeTarget of ['wasm-browser', 'wasm-node'] as const) {
  Deno.test(`packageCompilerOutput writes runnable ${runtimeTarget} artifacts`, async () => {
    const tempDirectory = await Deno.makeTempDir({ prefix: 'soundscript-toolchain-' });
    const projectPath = join(tempDirectory, 'tsconfig.json');
    const outputDirectory = join(tempDirectory, 'soundscript-out');
    const watPath = join(outputDirectory, 'module.wat');
    const wasmPath = join(outputDirectory, 'module.wasm');
    const runtimePath = join(outputDirectory, 'runtime.js');
    const wrapperPath = join(outputDirectory, 'module.js');
    const declarationsPath = join(outputDirectory, 'module.d.ts');

    await Deno.writeTextFile(projectPath, '{}\n');
    await Deno.mkdir(outputDirectory, { recursive: true });
    await Deno.writeTextFile(wasmPath, 'stale wasm');

    const result = packageCompilerOutput({
      projectPath,
      runtimeTarget,
      wat: '(module (func (export "main") (result f64) f64.const 1))\n',
    });

    assertEquals(result.watPath, watPath);
    assertEquals(result.wasmPath, wasmPath);
    assertEquals(result.runtimePath, runtimePath);
    assertEquals(result.wrapperPath, wrapperPath);
    assertEquals(result.declarationsPath, declarationsPath);
    assertEquals(
      await Deno.readTextFile(watPath),
      '(module (func (export "main") (result f64) f64.const 1))\n',
    );
    assertEquals((await Deno.stat(wasmPath)).isFile, true);
    assertEquals((await Deno.stat(runtimePath)).isFile, true);
    assertEquals((await Deno.stat(wrapperPath)).isFile, true);
    assertEquals((await Deno.stat(declarationsPath)).isFile, true);
  });
}
