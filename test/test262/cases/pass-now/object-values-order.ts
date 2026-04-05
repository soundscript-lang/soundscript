export function main(): string {
  const record = { 2: 'b', 1: 'a', zebra: 'z' };
  let summary = '';

  for (const value of Object.values(record)) {
    summary += value;
  }

  return summary;
}
