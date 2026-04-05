export function main(): Promise<number> {
  return Promise.allSettled([Promise.resolve(4)]).then((results) =>
    results[0].status === 'fulfilled' ? results[0].value : 0
  );
}
