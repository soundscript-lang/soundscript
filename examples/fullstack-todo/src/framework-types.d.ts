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
  export function hydrateRoot(
    container: Element | DocumentFragment,
    children: ReactElement,
  ): Root;
}

declare module 'react-dom/server' {
  type ReactElement = import('react/jsx-runtime').ReactElement;

  export function renderToString(children: ReactElement): string;
}

declare module 'react-router' {
  type ReactElement = import('react/jsx-runtime').ReactElement;

  export interface RouteProps {
    path: string;
    element: ReactElement;
  }

  export interface RoutesProps {
    children?: ReactElement | readonly ReactElement[];
  }

  export interface StaticRouterProps {
    location: string;
    children?: ReactElement;
  }

  export function Route(props: RouteProps): ReactElement;
  export function Routes(props: RoutesProps): ReactElement;
  export function StaticRouter(props: StaticRouterProps): ReactElement;
}

declare module 'react-router-dom' {
  type ReactElement = import('react/jsx-runtime').ReactElement;

  export interface HashRouterProps {
    children?: ReactElement;
  }

  export function HashRouter(props: HashRouterProps): ReactElement;
}
