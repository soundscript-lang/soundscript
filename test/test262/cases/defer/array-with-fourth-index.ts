export function main(): number {
  const values = [1, 2, 3, 4];
  try {
    values.with(10, 7);
    return 0;
  } catch (error) {
    return error instanceof RangeError ? 1 : 2;
  }
}
