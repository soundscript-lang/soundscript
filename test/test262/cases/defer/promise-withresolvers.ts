declare global {
  interface PromiseConstructor {
    withResolvers<T>(): {
      promise: Promise<T>;
      resolve(value: T | PromiseLike<T>): void;
      reject(reason?: unknown): void;
    };
  }
}

export {};

export function main(): number {
  const { promise, resolve } = Promise.withResolvers<number>();
  resolve(5);
  void promise.then(() => undefined);
  return 5;
}
