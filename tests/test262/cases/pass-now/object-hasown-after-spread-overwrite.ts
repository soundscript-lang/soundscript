export function main(): boolean {
  const source: Record<string, number> = { left: 2 };
  const target = { left: 1, ...source };
  return Object.hasOwn(target, 'left') && target.left === 2;
}
