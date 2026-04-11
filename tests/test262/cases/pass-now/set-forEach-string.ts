export function main(): number {
  const expects = ['a', 'b'];
  new Set(expects).forEach((value, entry) => {
    const expect = expects.shift();
    if (expect !== value || expect !== entry) {
      throw new Error('unexpected iteration order');
    }
  });
  return expects.length;
}
