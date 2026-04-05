export function main(): string {
  const record = { 2: 'b', 1: 'a', 10: 'j' };
  return Object.entries(record).map(([key, value]) => `${key}:${value}`).join(';');
}
