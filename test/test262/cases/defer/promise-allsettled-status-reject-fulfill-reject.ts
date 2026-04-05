export function main(): Promise<string> {
  return Promise.allSettled([
    Promise.reject(1),
    Promise.resolve(2),
    Promise.reject(3),
  ]).then((results) => results.map((result) => result.status).join(';'));
}
