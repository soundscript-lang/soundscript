import { assertEquals } from '@std/assert';

import {
  formatSoundscriptText,
  requiresProjectMacroDefinitionsForFormatting,
} from './format_soundscript.ts';

Deno.test('formatSoundscriptText formats block macros and nested expression macros', () => {
  const sourceText = [
    'function wrap(){',
    'Foo(() => {',
    'const value=Bar(source)',
    'void value',
    '})',
    '}',
    '',
  ].join('\n');

  assertEquals(
    formatSoundscriptText('example.sts', sourceText),
    [
      'function wrap() {',
      '    Foo(() => {',
      '        const value = Bar(source)',
      '        void value',
      '    })',
      '}',
      '',
    ].join('\n'),
  );
});

Deno.test('formatSoundscriptText formats callback-style call macros recursively', () => {
  const sourceText = [
    'const value=Outer(left,right,() => {',
    'const done=Try(value)',
    '})',
    '',
  ].join('\n');

  assertEquals(
    formatSoundscriptText('example.sts', sourceText),
    [
      'const value = Outer(left, right, () => {',
      '    const done = Try(value)',
      '})',
      '',
    ].join('\n'),
  );
});

Deno.test('formatSoundscriptText respects requested indentation and newline style', () => {
  const sourceText = [
    'function wrap(){',
    'Foo(() => {',
    'const value=Bar(source)',
    'void value',
    '})',
    '}',
    '',
  ].join('\n');

  assertEquals(
    formatSoundscriptText('example.sts', sourceText, {
      indentText: '\t',
      newLine: '\r\n',
    }),
    [
      'function wrap() {',
      '\tFoo(() => {',
      '\t\tconst value = Bar(source)',
      '\t\tvoid value',
      '\t})',
      '}',
      '',
    ].join('\r\n'),
  );
});

Deno.test('formatSoundscriptText formats Match array-arm syntax with imports', () => {
  const sourceText = [
    "import { Match } from 'sts:match'",
    "const result=Match(value,[(ok:'ok')=> compute( left,right ),(_)=>fallback(value)])",
    '',
  ].join('\n');

  assertEquals(
    formatSoundscriptText('example.sts', sourceText),
    [
      "import { Match } from 'sts:match'",
      "const result = Match(value, [(ok: 'ok') => compute(left, right), (_) => fallback(value)])",
      '',
    ].join('\n'),
  );
});

Deno.test('formatSoundscriptText formats guarded Match array arms through where(...)', () => {
  const sourceText = [
    "import { Match, where } from 'sts:match'",
    "const result=Match(value,[where((ok:'ok')=>compute( value ),(ok)=>isValid( ok )),(_)=>fallback(value)])",
    '',
  ].join('\n');

  assertEquals(
    formatSoundscriptText('example.sts', sourceText),
    [
      "import { Match, where } from 'sts:match'",
      "const result = Match(value, [where((ok: 'ok') => compute(value), (ok) => isValid(ok)), (_) => fallback(value)])",
      '',
    ].join('\n'),
  );
});

Deno.test('formatSoundscriptText formats embedded sql template fragments and hole expressions', () => {
  const sourceText = [
    "import { sql } from 'sts:experimental/sql'",
    'const query=sql`select *',
    'from users',
    'where id = ${ userId }`',
    '',
  ].join('\n');

  assertEquals(
    formatSoundscriptText('example.sts', sourceText),
    [
      "import { sql } from 'sts:experimental/sql'",
      'const query = sql`SELECT *',
      '  FROM users',
      '  WHERE id = ${userId}`',
      '',
    ].join('\n'),
  );
});

Deno.test('formatSoundscriptText formats embedded css template fragments and hole expressions', () => {
  const sourceText = [
    "import { css } from 'sts:experimental/css'",
    'const style=css`button{color:${ primaryColor };background:${css.raw(backgroundCss)};}`',
    '',
  ].join('\n');

  assertEquals(
    formatSoundscriptText('example.sts', sourceText),
    [
      "import { css } from 'sts:experimental/css'",
      'const style = css`button {',
      '  color: ${primaryColor};',
      '  background: ${css.raw(backgroundCss)};',
      '}`',
      '',
    ].join('\n'),
  );
});

Deno.test('formatSoundscriptText formats embedded graphql template fragments and hole expressions', () => {
  const sourceText = [
    "import { graphql } from 'sts:experimental/graphql'",
    'const query=graphql`query User{user(id:${ userId }){name profilePhoto(size:${graphql.raw(imageSizeExpr)})}}`',
    '',
  ].join('\n');

  assertEquals(
    formatSoundscriptText('example.sts', sourceText),
    [
      "import { graphql } from 'sts:experimental/graphql'",
      'const query = graphql`query User {',
      '  user(id: ${userId}) {',
      '    name',
      '    profilePhoto(size: ${graphql.raw(imageSizeExpr)})',
      '  }',
      '}`',
      '',
    ].join('\n'),
  );
});

Deno.test('formatSoundscriptText formats declaration annotations on imported underscore macros', () => {
  const sourceText = [
    "import { component } from './macro_module.ts';",
    '',
    '// #[component]',
    'class  TodoView{',
    'render(){',
    'return <div />',
    '}',
    '}',
    '',
  ].join('\n');

  assertEquals(
    formatSoundscriptText('example.sts', sourceText),
    [
      "import { component } from './macro_module.ts';",
      '',
      '// #[component]',
      'class TodoView {',
      '    render() {',
      '        return <div />',
      '    }',
      '}',
      '',
    ].join('\n'),
  );
});

Deno.test('requiresProjectMacroDefinitionsForFormatting stays false for builtin-only macro files', () => {
  const sourceText = [
    "import { Try } from 'sts:result';",
    "import { Match } from 'sts:match';",
    '',
    'const value = Try(load());',
    "const label = Match(value, [(x: number) => 'ok', (_) => 'err']);",
    '',
  ].join('\n');

  assertEquals(
    requiresProjectMacroDefinitionsForFormatting('example.sts', sourceText),
    false,
  );
});

Deno.test('requiresProjectMacroDefinitionsForFormatting requests project definitions for imported user macros', () => {
  const sourceText = [
    "import { Custom } from './macro_module.ts';",
    '',
    'const value = Custom(1);',
    '',
  ].join('\n');

  assertEquals(
    requiresProjectMacroDefinitionsForFormatting('example.sts', sourceText),
    true,
  );
});
