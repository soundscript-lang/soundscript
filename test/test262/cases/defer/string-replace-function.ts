export function main(): string {
  return 'abc12 def34'.replace(
    /([a-z]+)([0-9]+)/g,
    (_match: string, alpha: string, digits: string): string => digits + alpha,
  );
}
