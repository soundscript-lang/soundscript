export function main(): Promise<number> {
  return Promise.any([Promise.resolve(1), Promise.resolve(2)]);
}
