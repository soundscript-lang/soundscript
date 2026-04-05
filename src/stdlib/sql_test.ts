import { assertEquals } from '@std/assert';

import { sql } from './sql.ts';

Deno.test('sql tag builds a query object with numbered placeholders', () => {
  const query = sql`select * from users where id = ${42} and active = ${true}`;

  assertEquals(query, {
    text: 'select * from users where id = $1 and active = $2',
    params: [42, true],
  });
});

Deno.test('sql helper constructors preserve fragment markers', () => {
  assertEquals(sql.ident('users'), { __sqlKind: 'identifier', name: 'users' });
  assertEquals(sql.raw('count(*)'), { __sqlKind: 'raw', text: 'count(*)' });
});
