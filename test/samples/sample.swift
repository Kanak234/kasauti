func classify(a: Int, b: Int) -> Int {
    if a > 0 && b > 0 {
        return 1
    } else if a < 0 {
        return 2
    } else {
        return 3
    }
}

func loop(n: Int, m: Int) -> Int {
    var total = 0
    for _ in 0..<n {
        while total < m {
            if total == 7 {
                total = total + 2
            }
            total = total + 1
        }
    }
    return total
}
