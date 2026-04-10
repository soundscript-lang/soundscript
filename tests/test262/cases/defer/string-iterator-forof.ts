export function main(): number {
  let iterationCount = 0;
  for (const value of 'abc') {
    iterationCount += 1;
  }
  return iterationCount;
}
