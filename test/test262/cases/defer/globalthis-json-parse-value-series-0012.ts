export function main(): number {
  return globalThis.JSON.parse('{"value":12}').value;
}
