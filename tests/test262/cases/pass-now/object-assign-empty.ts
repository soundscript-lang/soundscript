export function main(): number {
  const target = { left: 1 };
  return Object.assign(target, {}).left;
}
