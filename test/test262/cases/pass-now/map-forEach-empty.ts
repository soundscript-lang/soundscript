export function main(): undefined {
  const result = new Map<string, number>().forEach(() => {
    throw new Error('unreachable');
  });
  return result;
}
