export function main(): Promise<string> {
  return Promise.allSettled([
    Promise.resolve(1),
    Promise.reject(2),
    Promise.reject(3),
  ]).then((results) => results[2].status);
}
