export function main(): number {
  const left = { 1: 1 };
  const right = { 1: 3 };
  const target = { ...left, ...right, 2: 2 };
  return target[1] * 100 + target[2];
}
