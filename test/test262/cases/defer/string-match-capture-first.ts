export function main(): string | null {
  const matched = '123456abcde7890'.match(/\d{2}/g);
  return matched ? (matched[1] ?? null) : null;
}
