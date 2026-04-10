export function main(): Promise<string> {
  return Promise.allSettled([Promise.resolve(35), Promise.resolve(36)]).then((results) =>
    results.map((result) => result.status).join(';')
  );
}
