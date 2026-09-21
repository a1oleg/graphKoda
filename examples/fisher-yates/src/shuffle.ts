


//алгоритм Фишера-Йетса
export function shuffle(): string[] {



  
  const alphabet = ['А', 'Б', 'В', 'Г', 'Д', 'Е', 'Ё', 'Ж'];
  //пример результата: ['Е', 'В', 'А', 'Ж', 'Б', 'Ё', 'Г', 'Д']
  
  
    
  
  let current: { index: number; value: string | undefined } 
  = { index: alphabet.length - 1, 
      value: undefined };

  
  
  
 
 
 for (; current.index > 0; current.index--) {
    current.value = alphabet[current.index];
    const random = getRandom(current.index + 1);
    swap(alphabet, current, random);
  }

  return alphabet;
}

function getRandom(length: number): number {
  const index = Math.floor(Math.random() * length);
  return index;
}

function swap<T>(alphabet: T[], current: { index: number; value: T | undefined }, random: number): void {
  alphabet[current.index] = alphabet[random];
  alphabet[random] = current.value!;
}
