export function main(key: string, value: number): number {
  const source = { [key]: value, right: value + 1 };
  const target = Object.assign({}, source);
  return target[key] * 10 + target.right;
}
