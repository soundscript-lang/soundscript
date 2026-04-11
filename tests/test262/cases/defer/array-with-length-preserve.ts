export function main(): readonly number[] {
  const arrayLike = { length: '2', 0: 1, 1: 2, 2: 3 };
  return Array.prototype.with.call(arrayLike, 0, 4);
}
