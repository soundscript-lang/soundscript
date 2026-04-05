export function main(): number {
  return globalThis.JSON.parse('{"value":17}').value;
}
