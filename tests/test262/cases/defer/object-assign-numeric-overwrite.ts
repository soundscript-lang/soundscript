export function main(): number {
  const target = { 1: 1, 2: 2 };
  Object.assign(target, { 1: 3 });
  return target[1] * 100 + target[2];
}
