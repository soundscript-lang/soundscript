export function main(): Promise<string> {
  return Promise.allSettled([Promise.resolve(1)]).then((results) => results[0].status);
}
