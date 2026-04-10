export function main(): string {
  const date = new Date(0);
  date.prop1 = 100;
  date.prop2 = 'prop2';
  return Object.keys(date).join(',');
}
