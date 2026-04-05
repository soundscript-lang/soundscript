export function main(): number {
  const values = [1, 2, 3, 4, 5];
  try {
    values.with(2 ** 53 + 2, 9);
    return 0;
  } catch (error) {
    return error instanceof RangeError ? 1 : 2;
  }
}
