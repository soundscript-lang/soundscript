export function factorial(input: number): number {
  let result = 1;
  let current = input;

  while (current > 1) {
    result = result * current;
    current = current - 1;
  }

  return result;
}
