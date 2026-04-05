export function main(): number {
  const source = { left: 1, inner: { right: 2 } };
  const target: { left?: number; inner?: { right: number } } = {};
  Object.assign(target, source);
  return target.left! + target.inner!.right;
}
