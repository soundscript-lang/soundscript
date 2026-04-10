export function main(): Promise<number> {
  return Promise.any([Promise.reject(1), Promise.resolve(2)]);
}
