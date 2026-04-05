export function main(): readonly number[] {
  return [0, 4, 16].with(NaN, 2);
}
