export function main(): Promise<string> {
  return Promise.allSettled([1, Promise.reject(2)]).then((results) =>
    `${results[0].status}:${results[1].status}`
  );
}
