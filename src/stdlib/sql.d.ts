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

export const sql: SqlTag;
