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

const graphqlTag: GraphqlTag = Object.assign(
  (strings: TemplateStringsArray, ...values: readonly unknown[]): GraphqlQuery => ({
    query: String.raw({ raw: strings }, ...values.map(String)),
    values: [...values],
  }),
  {
    raw(text: string): GraphqlRawFragment {
      return { __graphqlKind: 'raw', text };
    },
  },
);

export const graphql = graphqlTag;
