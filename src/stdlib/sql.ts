export interface SqlQuery {
  readonly text: string;
  readonly params: readonly unknown[];
}

export interface SqlIdentifier {
  readonly __sqlKind: 'identifier';
  readonly name: string;
}

export interface SqlRawFragment {
  readonly __sqlKind: 'raw';
  readonly text: string;
}

export interface SqlTag {
  (strings: TemplateStringsArray, ...values: readonly unknown[]): SqlQuery;
  ident(name: string): SqlIdentifier;
  raw(text: string): SqlRawFragment;
}

function buildSqlQuery(
  strings: TemplateStringsArray,
  values: readonly unknown[],
): SqlQuery {
  let text = '';
  for (let index = 0; index < strings.length; index += 1) {
    text += strings[index] ?? '';
    if (index < values.length) {
      text += `$${index + 1}`;
    }
  }

  return {
    text,
    params: [...values],
  };
}

const sqlTag = ((strings: TemplateStringsArray, ...values: readonly unknown[]) =>
  buildSqlQuery(strings, values)) as SqlTag;

sqlTag.ident = (name: string): SqlIdentifier => ({
  __sqlKind: 'identifier',
  name,
});

sqlTag.raw = (text: string): SqlRawFragment => ({
  __sqlKind: 'raw',
  text,
});

export const sql = sqlTag;
