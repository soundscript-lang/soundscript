export function main(): Promise<number> {
  return Promise.any([
    Promise.resolve(1),
    Promise.resolve(2),
    Promise.resolve(3),
    Promise.resolve(4),
  ]);
}
