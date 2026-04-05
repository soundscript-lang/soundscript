export function main(): boolean {
  const source = { left: true };
  const target = { ...source };
  return target.left;
}
