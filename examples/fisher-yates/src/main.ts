import { shuffle } from './shuffle.js';

export function createTurnOrder(players: readonly string[]): string[] {
  return shuffle(players);
}

const players = ['Alice', 'Bob', 'Charlie', 'Diana'];
const turnOrder = createTurnOrder(players);
console.log({ players, turnOrder });
