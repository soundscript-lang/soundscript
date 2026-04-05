export interface GraphqlRawFragment {
  readonly __graphqlKind: 'raw';
  readonly text: string;
}

export interface GraphqlQuery {
  readonly query: string;
  readonly values: readonly unknown[];
}

export interface GraphqlTag {
  (strings: TemplateStringsArray, ...values: readonly unknown[]): GraphqlQuery;
  raw(text: string): GraphqlRawFragment;
}

export const graphql: GraphqlTag;
