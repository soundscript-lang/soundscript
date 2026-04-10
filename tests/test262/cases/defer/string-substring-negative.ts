export function main(): string {
  const value = {
    toString() {},
  };
  return String(value).substring(-4, undefined);
}
