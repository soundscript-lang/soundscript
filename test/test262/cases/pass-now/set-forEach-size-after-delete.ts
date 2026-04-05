export function main(): number {
  const expects = [2];
  const set = new Set([1, 2]);
  set.delete(1);
  set.forEach((value, entry) => {
    const expect = expects.shift();
    if (expect !== value || expect !== entry) {
      throw new Error('unexpected iteration order');
    }
  });
  return expects.length;
}
