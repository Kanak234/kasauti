let classify = (a, b) => {
  if a > 0 && b > 0 {
    1
  } else if a < 0 {
    2
  } else {
    3
  }
}

let loop = (n, m) => {
  let total = ref(0)
  for _i in 1 to n {
    while total.contents < m {
      if total.contents == 7 {
        total := total.contents + 2
      }
      total := total.contents + 1
    }
  }
  total.contents
}
