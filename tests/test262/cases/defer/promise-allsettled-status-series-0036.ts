export function main(): Promise<string> {
  return Promise.allSettled([Promise.resolve(36), Promise.resolve(37)]).then((results) =>
    results.map((result) => result.status).join(';')
  );
}
