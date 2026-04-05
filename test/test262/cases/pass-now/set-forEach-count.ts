export function main(): number {
  const expects = [1, 2, 3];
  new Set(expects).forEach((value, entry) => {
    const expect = expects.shift();
    if (expect !== value || expect !== entry) {
      throw new Error('unexpected iteration order');
    }
  });
  return expects.length;
}
