export type ValueMode = 'shallow' | 'deep';
export type ValueRoute = 'local' | 'namedImport' | 'defaultImport' | 'barrelReexport';

export const VALUE_MODES: readonly ValueMode[] = ['shallow', 'deep'];
export const VALUE_ROUTES: readonly ValueRoute[] = [
  'local',
  'namedImport',
  'defaultImport',
  'barrelReexport',
];

export interface ValueMatrixProgram {
  readonly definitionFile: string;
  readonly entryFile: string;
  readonly files: Readonly<Record<string, string>>;
}

const BOX_CLASS_NAME = 'Box';
const LEAF_CLASS_NAME = 'Leaf';

function getValueAnnotation(mode: ValueMode): string {
  return mode === 'deep' ? '// #[value(deep: true)]' : '// #[value]';
}

export function getValueModeSlug(mode: ValueMode): string {
  return mode;
}

export function getValueModeLabel(mode: ValueMode): string {
  return mode === 'deep' ? 'deep' : 'shallow';
}

export function getValueRouteSlug(route: ValueRoute): string {
  switch (route) {
    case 'local':
      return 'local';
    case 'namedImport':
      return 'named-import';
    case 'defaultImport':
      return 'default-import';
    case 'barrelReexport':
      return 'barrel-reexport';
  }
}

export function getValueRouteLabel(route: ValueRoute): string {
  switch (route) {
    case 'local':
      return 'local declarations';
    case 'namedImport':
      return 'named imports';
    case 'defaultImport':
      return 'default imports';
    case 'barrelReexport':
      return 'barrel reexports';
  }
}

function createSimpleValueClassSource(mode: ValueMode, exportKind: 'named' | 'default'): string {
  const exportPrefix = exportKind === 'default' ? 'export default class' : 'export class';
  return [
    getValueAnnotation(mode),
    `${exportPrefix} ${BOX_CLASS_NAME} {`,
    '  readonly x: number;',
    '',
    '  constructor(x: number) {',
    '    this.x = x;',
    '  }',
    '}',
    '',
  ].join('\n');
}

function createLocalSimpleValueProgram(mode: ValueMode): ValueMatrixProgram {
  return {
    definitionFile: 'index.sts',
    entryFile: 'index.sts',
    files: {
      'index.sts': [
        createSimpleValueClassSource(mode, 'named'),
        `const same = new ${BOX_CLASS_NAME}(1) === new ${BOX_CLASS_NAME}(1);`,
        'void same;',
        '',
      ].join('\n'),
    },
  };
}

function createImportedSimpleValueProgram(
  mode: ValueMode,
  route: Exclude<ValueRoute, 'local'>,
): ValueMatrixProgram {
  if (route === 'namedImport') {
    return {
      definitionFile: 'box.sts',
      entryFile: 'index.sts',
      files: {
        'box.sts': createSimpleValueClassSource(mode, 'named'),
        'index.sts': [
          'import { Box } from "./box.sts";',
          '',
          'const same = new Box(1) === new Box(1);',
          'void same;',
          '',
        ].join('\n'),
      },
    };
  }

  if (route === 'defaultImport') {
    return {
      definitionFile: 'box.sts',
      entryFile: 'index.sts',
      files: {
        'box.sts': createSimpleValueClassSource(mode, 'default'),
        'index.sts': [
          'import Box from "./box.sts";',
          '',
          'const same = new Box(1) === new Box(1);',
          'void same;',
          '',
        ].join('\n'),
      },
    };
  }

  return {
    definitionFile: 'box.sts',
    entryFile: 'index.sts',
    files: {
      'box.sts': createSimpleValueClassSource(mode, 'named'),
      'barrel.sts': 'export { Box } from "./box.sts";\n',
      'index.sts': [
        'import { Box } from "./barrel.sts";',
        '',
        'const same = new Box(1) === new Box(1);',
        'void same;',
        '',
      ].join('\n'),
    },
  };
}

function createDeepLeafSource(valid: boolean, exportKind: 'named' | 'default'): string {
  const exportPrefix = exportKind === 'default' ? 'export default class' : 'export class';
  return [
    getValueAnnotation('deep'),
    `${exportPrefix} ${LEAF_CLASS_NAME} {`,
    '  readonly x: number;',
    '',
    '  constructor(x: number) {',
    '    this.x = x;',
    '  }',
    ...(valid
      ? []
      : [
        '',
        '  get y(): number {',
        '    return this.x;',
        '  }',
      ]),
    '}',
    '',
  ].join('\n');
}

function createDeepBoxSource(
  leafImportLine: string | null,
  leafTypeName: string,
  exportKind: 'named' | 'default',
): string {
  const exportPrefix = exportKind === 'default' ? 'export default class' : 'export class';
  return [
    ...(leafImportLine ? [leafImportLine, ''] : []),
    getValueAnnotation('deep'),
    `${exportPrefix} ${BOX_CLASS_NAME} {`,
    `  readonly leaf: ${leafTypeName};`,
    '',
    `  constructor(leaf: ${leafTypeName}) {`,
    '    this.leaf = leaf;',
    '  }',
    '}',
    '',
  ].join('\n');
}

function createDeepValueProgram(route: ValueRoute, validLeaf: boolean): ValueMatrixProgram {
  if (route === 'local') {
    return {
      definitionFile: 'index.sts',
      entryFile: 'index.sts',
      files: {
        'index.sts': [
          createDeepLeafSource(validLeaf, 'named'),
          createDeepBoxSource(null, LEAF_CLASS_NAME, 'named'),
          `const same = new ${BOX_CLASS_NAME}(new ${LEAF_CLASS_NAME}(1)) === new ${BOX_CLASS_NAME}(new ${LEAF_CLASS_NAME}(1));`,
          'void same;',
          '',
        ].join('\n'),
      },
    };
  }

  if (route === 'namedImport') {
    return {
      definitionFile: 'box.sts',
      entryFile: 'index.sts',
      files: {
        'leaf.sts': createDeepLeafSource(validLeaf, 'named'),
        'box.sts': createDeepBoxSource(
          'import { Leaf } from "./leaf.sts";',
          'Leaf',
          'named',
        ),
        'index.sts': 'import { Box } from "./box.sts";\nvoid Box;\n',
      },
    };
  }

  if (route === 'defaultImport') {
    return {
      definitionFile: 'box.sts',
      entryFile: 'index.sts',
      files: {
        'leaf.sts': createDeepLeafSource(validLeaf, 'default'),
        'box.sts': createDeepBoxSource(
          'import Leaf from "./leaf.sts";',
          'Leaf',
          'default',
        ),
        'index.sts': 'import Box from "./box.sts";\nvoid Box;\n',
      },
    };
  }

  return {
    definitionFile: 'box.sts',
    entryFile: 'index.sts',
    files: {
      'leaf.sts': createDeepLeafSource(validLeaf, 'default'),
      'leaf_barrel.sts': 'export { default as Leaf } from "./leaf.sts";\n',
      'box.sts': createDeepBoxSource(
        'import { Leaf } from "./leaf_barrel.sts";',
        'Leaf',
        'named',
      ),
      'box_barrel.sts': 'export { Box } from "./box.sts";\n',
      'index.sts': 'import { Box } from "./box_barrel.sts";\nvoid Box;\n',
    },
  };
}

export function createValueRouteProgram(mode: ValueMode, route: ValueRoute): ValueMatrixProgram {
  if (mode === 'deep') {
    return createDeepValueProgram(route, true);
  }

  if (route === 'local') {
    return createLocalSimpleValueProgram(mode);
  }

  return createImportedSimpleValueProgram(mode, route);
}

export function createInvalidDeepValueRouteProgram(route: ValueRoute): ValueMatrixProgram {
  return createDeepValueProgram(route, false);
}

export function prefixValueMatrixProgram(
  program: ValueMatrixProgram,
  prefix: string,
): ValueMatrixProgram {
  const normalizedPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`;
  const prefixedFiles = Object.fromEntries(
    Object.entries(program.files).map(([fileName, source]) => [
      `${normalizedPrefix}${fileName}`,
      source,
    ]),
  );

  return {
    definitionFile: `${normalizedPrefix}${program.definitionFile}`,
    entryFile: `${normalizedPrefix}${program.entryFile}`,
    files: prefixedFiles,
  };
}
