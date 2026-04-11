export function main(): readonly number[] {
  const arr = Object.freeze([0, 1, 2]);
  return arr.with(1, 3);
}
