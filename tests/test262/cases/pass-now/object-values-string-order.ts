export function main(): string {
  const record = { zebra: 'z', alpha: 'a', middle: 'm' };
  return Object.values(record).join('');
}
