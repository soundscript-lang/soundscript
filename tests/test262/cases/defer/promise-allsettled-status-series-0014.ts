export function main(): Promise<string> {
  return Promise.allSettled([Promise.resolve(14), Promise.resolve(15)]).then((results) =>
    results.map((result) => result.status).join(';')
  );
}
