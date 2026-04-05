export function main(): Promise<number> {
  return Promise.resolve(Promise.resolve(3));
}
