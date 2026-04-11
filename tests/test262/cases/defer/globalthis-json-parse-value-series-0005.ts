export function main(): number {
  return globalThis.JSON.parse('{"value":5}').value;
}
