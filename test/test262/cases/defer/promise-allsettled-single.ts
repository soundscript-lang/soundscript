export function main(value: number): Promise<string> {
  return Promise.allSettled([Promise.resolve(value)]).then((results) => results[0].status);
}
