declare global {
  interface PromiseConstructor {
    try<T>(callbackfn: () => T | PromiseLike<T>): Promise<T>;
  }
}

export {};

export function main(): number {
  void Promise.try(() => 5).then(() => undefined);
  return 5;
}
