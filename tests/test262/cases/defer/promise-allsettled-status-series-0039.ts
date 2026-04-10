export function main(): Promise<string> {
  return Promise.allSettled([Promise.resolve(39), Promise.resolve(40)]).then((results) =>
    results.map((result) => result.status).join(';')
  );
}
