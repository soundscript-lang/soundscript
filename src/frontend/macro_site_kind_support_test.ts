import { assertEquals } from '@std/assert';

import { collectImportedMacroSiteKindsBySpecifier } from './macro_site_kind_support.ts';

Deno.test(
  'collectImportedMacroSiteKindsBySpecifier skips resolving imports with no macro-position usage',
  () => {
    const resolvedSpecifiers: string[] = [];
    const collected = collectImportedMacroSiteKindsBySpecifier(
      '/virtual/index.sts',
      [
        "import { Used } from 'macros/used';",
        "import { Unused } from 'macros/unused';",
        'const value = Used(1);',
        'void value;',
        'void Unused;',
        '',
      ].join('\n'),
      {
        resolveOnlySyntaxCandidates: true,
        resolveSiteKindsForSpecifier: (specifier) => {
          resolvedSpecifiers.push(specifier);
          return new Map([['Used', 'call']]);
        },
      },
    );

    assertEquals(resolvedSpecifiers, ['macros/used']);
    assertEquals(collected, new Map([['macros/used', new Map([['Used', 'call']])]]));
  },
);

Deno.test(
  'collectImportedMacroSiteKindsBySpecifier avoids all resolution when imports are never used as macros',
  () => {
    const resolvedSpecifiers: string[] = [];
    const collected = collectImportedMacroSiteKindsBySpecifier(
      '/virtual/index.ts',
      [
        "import { Foo } from 'macros/foo';",
        "import { Bar } from 'macros/bar';",
        'const value = Foo + Bar;',
        'void value;',
        '',
      ].join('\n'),
      {
        resolveOnlySyntaxCandidates: true,
        resolveSiteKindsForSpecifier: (specifier) => {
          resolvedSpecifiers.push(specifier);
          return new Map([['Foo', 'call']]);
        },
      },
    );

    assertEquals(resolvedSpecifiers, []);
    assertEquals(collected, new Map());
  },
);
