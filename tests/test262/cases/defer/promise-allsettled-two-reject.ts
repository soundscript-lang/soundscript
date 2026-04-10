export function main(): Promise<string> {
  return Promise.allSettled([Promise.reject(1), Promise.reject(2)]).then((results) =>
    results[1].status
  );
}
