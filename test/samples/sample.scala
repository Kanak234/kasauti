object Sample {
  def classify(a: Int, b: Int): Int = {
    if (a > 0 && b > 0) {
      1
    } else if (a < 0) {
      2
    } else {
      3
    }
  }

  def loop(n: Int, m: Int): Int = {
    var total = 0
    for (i <- 0 until n) {
      while (total < m) {
        if (total == 7) {
          total = total + 2
        }
        total = total + 1
      }
    }
    total
  }
}
