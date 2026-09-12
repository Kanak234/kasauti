function classify(a: number, b: number): number {
  if (a > 0 && b > 0) {
    return 1;
  } else if (a < 0) {
    return 2;
  } else {
    return 3;
  }
}

function loop(n: number, m: number): number {
  let total = 0;
  for (let i = 0; i < n; i++) {
    while (total < m) {
      if (total === 7) {
        total = total + 2;
      }
      total = total + 1;
    }
  }
  return total;
}
