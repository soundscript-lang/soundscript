export function main(): string | null {
  const matched = '123456abcde7890'.match(/\D{2}/g);
  return matched ? matched[0] : null;
}
