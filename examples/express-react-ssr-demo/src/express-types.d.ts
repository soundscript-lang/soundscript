type MinimalRequest = Pick<import('express').Request, 'url'>;
type MinimalResponse = Pick<import('express').Response, 'send'>;

interface MinimalApp {
  get(path: string, handler: (req: MinimalRequest, res: MinimalResponse) => void): void;
  listen(port: number): void;
}
