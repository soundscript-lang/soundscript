export function main(): Promise<number> {
  return Promise.any([
    Promise.reject(1),
    Promise.reject(2),
    Promise.resolve(3),
  ]);
}
