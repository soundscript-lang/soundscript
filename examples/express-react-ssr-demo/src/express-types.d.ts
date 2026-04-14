interface MinimalRequest {
  url: string;
}

interface MinimalResponse {
  send(html: string): MinimalResponse;
}

interface MinimalApp {
  get(path: string, handler: (req: MinimalRequest, res: MinimalResponse) => void): void;
  listen(port: number): void;
}

declare module 'express' {
  interface Request extends MinimalRequest {}

  interface Response extends MinimalResponse {}

  interface ExpressApp {
    get(path: string, handler: (req: Request, res: Response) => void): ExpressApp;
    listen(port: number): unknown;
  }

  export default function express(): ExpressApp;
}
