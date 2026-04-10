type Mixed = { zebra: number; 2: number; apple: number; 1: number };

export function main(left: number, right: number): number {
  const mixed: Mixed = { zebra: left, 2: right, apple: left, 1: right };
  return Object.keys(mixed).length;
}
