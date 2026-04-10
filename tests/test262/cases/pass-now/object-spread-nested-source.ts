export function main(): number {
  const source = { left: 1, inner: { right: 2 } };
  const target = { ...source };
  return target.left + target.inner.right;
}
