export function main(): boolean {
  const value = Promise.any([]);
  return value instanceof Object && value instanceof Promise;
}
