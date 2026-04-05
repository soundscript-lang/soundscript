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

export const css: CssTag;
