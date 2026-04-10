export function main(): string {
  const record = { 2: 'b', 1: 'a', zebra: 'z' };
  let summary = '';

  for (const [key, value] of Object.entries(record)) {
    summary += `${key}:${value};`;
  }

  return summary;
}
