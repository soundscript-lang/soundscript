interface MinimalRequest {
  url: string;
  params: {
    id: string;
  };
}

interface MinimalResponse {
  send(html: string): MinimalResponse;
  json(
    payload: {
      firstCompleted: boolean;
      secondCompleted: boolean;
      toggledId: string;
    },
  ): MinimalResponse;
  status(code: number): MinimalResponse;
}

interface MinimalApp {
  get(
    path: string,
    handler: (req: MinimalRequest, res: MinimalResponse) => Promise<void>,
  ): void;
  post(
    path: string,
    handler: (req: MinimalRequest, res: MinimalResponse) => Promise<void>,
  ): void;
  listen(port: number): void;
}

declare module 'express' {
  interface Request extends MinimalRequest {}

  interface Response extends MinimalResponse {}

  interface ExpressApp {
    get(path: string, handler: (req: Request, res: Response) => Promise<void>): ExpressApp;
    post(
      path: string,
      handler: (req: Request, res: Response) => Promise<void>,
    ): ExpressApp;
    listen(port: number): unknown;
  }

  export default function express(): ExpressApp;
}
