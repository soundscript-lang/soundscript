export function main(): Promise<string> {
  return globalThis.Promise.allSettled([1, Promise.reject(2)]).then((results) =>
    results.map((result) => result.status).join(';')
  );
}
