export function main(): Promise<string> {
  return Promise.allSettled([Promise.resolve(31), Promise.resolve(32)]).then((results) =>
    results.map((result) => result.status).join(';')
  );
}
