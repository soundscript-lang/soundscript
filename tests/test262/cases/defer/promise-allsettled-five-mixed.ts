export function main(): Promise<string> {
  return Promise.allSettled([
    Promise.resolve(1),
    Promise.reject(2),
    Promise.resolve(3),
    Promise.reject(4),
    Promise.resolve(5),
  ]).then((results) => results[4].status);
}
