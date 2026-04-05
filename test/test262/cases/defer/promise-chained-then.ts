export function main(): Promise<number> {
  return Promise.resolve(7).then((resolved) => resolved + 1).then((resolved) => resolved * 2);
}
