export function main(): number {
  const record = Object.fromEntries([
    ['left', true],
    ['right', false],
  ]);
  return record.left === true && record.right === false ? 1 : 0;
}
