export function main(): Promise<number> {
  return Promise.all([1, Promise.resolve(2), 3]).then((values) =>
    values[0] + values[1] + values[2]
  );
}
