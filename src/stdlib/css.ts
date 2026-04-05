export interface CssRawFragment {
  readonly __cssKind: 'raw';
  readonly text: string;
}

export interface CssTemplate {
  readonly text: string;
  readonly values: readonly unknown[];
}

export interface CssTag {
  (strings: TemplateStringsArray, ...values: readonly unknown[]): CssTemplate;
  raw(text: string): CssRawFragment;
}

const cssTag: CssTag = Object.assign(
  (strings: TemplateStringsArray, ...values: readonly unknown[]): CssTemplate => ({
    text: String.raw({ raw: strings }, ...values.map(String)),
    values: [...values],
  }),
  {
    raw(text: string): CssRawFragment {
      return { __cssKind: 'raw', text };
    },
  },
);

export const css = cssTag;
