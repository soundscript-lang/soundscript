export function main(): Promise<string> {
  return Promise.allSettled([
    Promise.resolve(1),
    Promise.reject(2),
    Promise.resolve(3),
    Promise.reject(4),
    Promise.resolve(5),
    Promise.reject(6),
  ]).then((results) => results[5].status);
}
