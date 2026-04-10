export function main(): Promise<string> {
  return Promise.allSettled([Promise.resolve(21), Promise.resolve(22)]).then((results) =>
    results.map((result) => result.status).join(';')
  );
}
