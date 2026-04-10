import { assertEquals, assertFalse, assertStringIncludes } from '@std/assert';

import { compileProject } from '../../src/compiler/compile_project.ts';
import {
  compileCheckedInProject,
  readWatArtifactForProject,
} from '../support/compiler/test_helpers.ts';
import { dirname, fromFileUrl, join } from '../../src/platform/path.ts';

const REPO_ROOT = dirname(dirname(dirname(fromFileUrl(import.meta.url))));

function exampleDirectory(relativeExampleDirectory: string): string {
  return join(REPO_ROOT, 'examples', relativeExampleDirectory);
}

async function collectFilesRecursively(rootDirectory: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(rootDirectory)) {
    const entryPath = join(rootDirectory, entry.name);
    if (entry.isDirectory) {
      files.push(...await collectFilesRecursively(entryPath));
      continue;
    }
    files.push(entryPath);
  }
  return files;
}

async function assertSourceDirectoryHasOnlyStsAndTypesFiles(
  projectDirectory: string,
  exampleName: string,
  allowedExtraRelativeFiles: string[] = [],
): Promise<void> {
  const sourceDirectory = join(projectDirectory, 'src');
  const files = await collectFilesRecursively(sourceDirectory);
  const allowedExtraFiles = new Set(
    allowedExtraRelativeFiles.map((relativePath) => join(projectDirectory, relativePath)),
  );

  for (const filePath of files) {
    const allowed = filePath.endsWith('.sts') ||
      filePath.endsWith('.d.ts') ||
      allowedExtraFiles.has(filePath);
    assertEquals(
      allowed,
      true,
      `${exampleName} source file must stay in .sts or .d.ts: ${filePath}`,
    );
  }
}

async function assertBootstrapEntryStaysBootstrapOnly(
  filePath: string,
  exampleName: string,
  expectedStartCall: string,
): Promise<void> {
  const contents = await Deno.readTextFile(filePath);

  assertStringIncludes(contents, 'compileProject');
  assertStringIncludes(contents, '.instantiate(');
  assertStringIncludes(contents, expectedStartCall);
  assertFalse(
    contents.includes("from 'express'"),
    `${exampleName} bootstrap should not import express directly`,
  );
  assertFalse(
    contents.includes('from "express"'),
    `${exampleName} bootstrap should not import express directly`,
  );
  assertFalse(
    contents.includes("from 'react'"),
    `${exampleName} bootstrap should not import react directly`,
  );
  assertFalse(
    contents.includes('from "react"'),
    `${exampleName} bootstrap should not import react directly`,
  );
  assertFalse(
    contents.includes('react-dom'),
    `${exampleName} bootstrap should not import react-dom directly`,
  );
  assertFalse(
    contents.includes('react-router'),
    `${exampleName} bootstrap should not import react-router directly`,
  );
  assertFalse(
    contents.includes('sequelize'),
    `${exampleName} bootstrap should not import sequelize directly`,
  );
  assertFalse(
    contents.includes('createRoot('),
    `${exampleName} bootstrap should not own React mounting logic`,
  );
  assertFalse(
    contents.includes('hydrateRoot('),
    `${exampleName} bootstrap should not own hydration logic`,
  );
  assertFalse(
    contents.includes('renderToString('),
    `${exampleName} bootstrap should not own SSR rendering logic`,
  );
  assertFalse(
    contents.includes('app.get('),
    `${exampleName} bootstrap should not define express routes`,
  );
  assertFalse(
    contents.includes('app.use('),
    `${exampleName} bootstrap should not define express middleware`,
  );
}

function assertBrowserCompileSucceeds(
  projectDirectory: string,
  browserTsconfigName: string,
  exampleName: string,
): void {
  const result = compileProject({
    projectPath: join(projectDirectory, browserTsconfigName),
    workingDirectory: projectDirectory,
  });

  assertEquals(result.exitCode, 0, `${exampleName} browser compile should succeed`);
  assertEquals(result.diagnostics, [], `${exampleName} browser compile should be clean`);
  assertEquals(
    Boolean(result.artifacts?.wrapperPath),
    true,
    `${exampleName} browser compile should emit a wrapper`,
  );
}

async function assertWatOmitsPromiseRuntimeAndHostBridge(
  projectDirectory: string,
  exampleName: string,
): Promise<void> {
  const watOutput = await readWatArtifactForProject(projectDirectory);

  assertFalse(
    watOutput.includes('__soundscript_promise_new_pending'),
    `${exampleName} should not emit internal promise runtime for sync-only example code`,
  );
  assertFalse(
    watOutput.includes('$host_promise_to_internal'),
    `${exampleName} should not emit host promise import bridges without promise host boundaries`,
  );
  assertFalse(
    watOutput.includes('$host_promise_to_host'),
    `${exampleName} should not emit host promise export bridges without promise host boundaries`,
  );
  assertFalse(
    watOutput.includes('"soundscript_promise"'),
    `${exampleName} should not import the soundscript promise bridge module`,
  );
}

Deno.test(
  'react-browser-demo bootstrap stays bootstrap-only and compiles',
  async () => {
    const { projectDirectory, result } = compileCheckedInProject('examples/react-browser-demo');

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(Boolean(result.artifacts?.wrapperPath), true);
    await assertWatOmitsPromiseRuntimeAndHostBridge(projectDirectory, 'react-browser-demo');

    await assertSourceDirectoryHasOnlyStsAndTypesFiles(
      projectDirectory,
      'react-browser-demo',
      ['src/bootstrap.js'],
    );

    const bootstrapPath = join(projectDirectory, 'src/bootstrap.js');
    const bootstrapContents = await Deno.readTextFile(bootstrapPath);

    assertStringIncludes(
      bootstrapContents,
      "import instantiate from '../soundscript-out/module.js';",
    );
    assertStringIncludes(bootstrapContents, "resolveExport(exports, 'start')");
    assertStringIncludes(bootstrapContents, 'start();');
    assertFalse(bootstrapContents.includes('createRoot('));
    assertFalse(bootstrapContents.includes('hydrateRoot('));
    assertFalse(bootstrapContents.includes('render('));
    assertFalse(bootstrapContents.includes('addEventListener'));
  },
);

Deno.test(
  'express-react-ssr-demo keeps src logic in .sts and compiles on both Wasm targets',
  async () => {
    const projectDirectory = exampleDirectory('express-react-ssr-demo');

    await assertSourceDirectoryHasOnlyStsAndTypesFiles(
      projectDirectory,
      'express-react-ssr-demo',
    );

    const serverResult = compileCheckedInProject('examples/express-react-ssr-demo');
    assertEquals(serverResult.result.exitCode, 0);
    assertEquals(serverResult.result.diagnostics, []);
    assertEquals(Boolean(serverResult.result.artifacts?.wrapperPath), true);
    await assertWatOmitsPromiseRuntimeAndHostBridge(
      projectDirectory,
      'express-react-ssr-demo server',
    );

    assertBrowserCompileSucceeds(
      projectDirectory,
      'browser.tsconfig.json',
      'express-react-ssr-demo',
    );
    await assertWatOmitsPromiseRuntimeAndHostBridge(
      projectDirectory,
      'express-react-ssr-demo browser',
    );

    await assertBootstrapEntryStaysBootstrapOnly(
      join(projectDirectory, 'dev.ts'),
      'express-react-ssr-demo',
      'start(port)',
    );
  },
);

Deno.test(
  'fullstack-todo keeps src logic in .sts and compiles on both Wasm targets',
  async () => {
    const projectDirectory = exampleDirectory('fullstack-todo');

    await assertSourceDirectoryHasOnlyStsAndTypesFiles(
      projectDirectory,
      'fullstack-todo',
    );

    const serverResult = compileCheckedInProject('examples/fullstack-todo');
    assertEquals(serverResult.result.exitCode, 0);
    assertEquals(serverResult.result.diagnostics, []);
    assertEquals(Boolean(serverResult.result.artifacts?.wrapperPath), true);
    await assertWatOmitsPromiseRuntimeAndHostBridge(
      projectDirectory,
      'fullstack-todo server',
    );

    assertBrowserCompileSucceeds(
      projectDirectory,
      'browser.tsconfig.json',
      'fullstack-todo',
    );
    await assertWatOmitsPromiseRuntimeAndHostBridge(
      projectDirectory,
      'fullstack-todo browser',
    );

    await assertBootstrapEntryStaysBootstrapOnly(
      join(projectDirectory, 'dev.ts'),
      'fullstack-todo',
      'start(port)',
    );
  },
);
