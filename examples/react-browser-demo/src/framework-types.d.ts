type ReactPrimitiveChild = string | number | bigint | boolean | null | undefined;
type ReactElementType = string | ((props: any) => unknown);

interface ReactElementShape {
  type: ReactElementType;
  props: unknown;
  key: string | null;
}

type ReactChild = ReactElementShape | ReactPrimitiveChild;
type ReactChildren = ReactChild | readonly ReactChild[];

declare module 'react/jsx-runtime' {
  export namespace JSX {
    interface IntrinsicElements {
      button: { children?: ReactChildren; onClick?: () => void };
      h1: { children?: ReactChildren };
      main: { children?: ReactChildren };
      p: { children?: ReactChildren };
    }
  }

  export type Key = string | number | bigint;
  export type ElementType = ReactElementType;

  export interface ReactElement extends ReactElementShape {}

  export function jsx(
    type: ElementType,
    props: unknown,
    key?: Key,
  ): ReactElement;

  export function jsxs(
    type: ElementType,
    props: unknown,
    key?: Key,
  ): ReactElement;
}

declare module 'react-dom/client' {
  type ReactElement = import('react/jsx-runtime').ReactElement;

  export interface Root {
    render(children: ReactElement): void;
    unmount(): void;
  }

  export function createRoot(container: Element | DocumentFragment): Root;
}
