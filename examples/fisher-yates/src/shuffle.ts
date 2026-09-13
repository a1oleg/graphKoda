export function shuffle<T>(items: readonly T[]): T[] {
  const shuffled = [...items];

  // Each iteration fixes one position; the prefix remains available for selection.
  for (let last = shuffled.length - 1; last > 0; last--) {
    const selected = randomIndex(last + 1);
    swap(shuffled, last, selected);
  }

  return shuffled;
}

function randomIndex(length: number): number {
  const index = Math.floor(Math.random() * length);
  return index;
}

function swap<T>(items: T[], first: number, second: number): void {
  const saved = items[first];
  items[first] = items[second];
  items[second] = saved;
}
