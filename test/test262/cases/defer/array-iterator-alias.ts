export function main(): number {
  const iterator = [1, 2, 3][Symbol.iterator]();
  const first = iterator.next();
  return first.done ? -1 : (iterator.next().value ?? -1);
}
