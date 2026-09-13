export function forControl(limit: number) {
  let total = 0;
  for (let index = 0; index < limit; index++) {
    if (index === 1) continue;
    if (index === 3) break;
    total += index;
  }
  return total;
}

export function forWithoutCondition() {
  for (;;) {
    break;
  }
  return 1;
}

export function forWithoutUpdate(limit: number) {
  for (let index = 0; index < limit;) {
    index += 1;
  }
  return limit;
}
