export function main(): undefined {
  const set = new Set([1, 2]);
  const result = set.clear();
  set.forEach(() => {
    throw new Error('unreachable');
  });
  return result;
}
