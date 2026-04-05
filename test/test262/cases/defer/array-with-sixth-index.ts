export function main(): number {
  const values = [1, 2, 3, 4, 5, 6];
  try {
    values.with(-10, 9);
    return 0;
  } catch (error) {
    return error instanceof RangeError ? 1 : 2;
  }
}
