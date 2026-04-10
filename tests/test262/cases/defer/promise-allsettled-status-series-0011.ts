export function main(): Promise<string> {
  return Promise.allSettled([Promise.resolve(11), Promise.resolve(12)]).then((results) =>
    results.map((result) => result.status).join(';')
  );
}
