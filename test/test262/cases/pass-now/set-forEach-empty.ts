export function main(): undefined {
  const result = new Set<number>().forEach(() => {
    throw new Error('unreachable');
  });
  return result;
}
