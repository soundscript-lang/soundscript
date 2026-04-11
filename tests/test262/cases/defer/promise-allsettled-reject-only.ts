export function main(): Promise<string> {
  return Promise.allSettled([Promise.reject(1)]).then((results) => results[0].status);
}
