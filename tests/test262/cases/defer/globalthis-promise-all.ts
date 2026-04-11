export function main(): Promise<number> {
  return globalThis.Promise.all([Promise.resolve(2), Promise.resolve(3)]).then((values) =>
    values[0] + values[1]
  );
}
