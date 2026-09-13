export function shuffle(): string[] {
  const alphabet = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

  // Each iteration fixes one position; the prefix remains available for selection.
  for (let current = alphabet.length - 1; current > 0; current--) {
    const random = getRandom(current + 1);
    swap(alphabet, current, random);
  }

  return alphabet;
}

function getRandom(length: number): number {
  const index = Math.floor(Math.random() * length);
  return index;
}

function swap<T>(alphabet: T[], current: number, random: number): void {
  const temporal = alphabet[current];
  alphabet[current] = alphabet[random];
  alphabet[random] = temporal;
}
