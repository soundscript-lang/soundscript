export function main(): Promise<string> {
  return Promise.allSettled([Promise.resolve(18), Promise.resolve(19)]).then((results) =>
    results.map((result) => result.status).join(';')
  );
}
