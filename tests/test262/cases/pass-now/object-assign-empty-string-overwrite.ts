export function main(): string {
  const target = Object.assign({ '': 'left' }, { '': 'right' });
  return target[''];
}
