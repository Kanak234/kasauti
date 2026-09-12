fn classify(a: i32, b: i32) i32 {
    if (a > 0 and b > 0) {
        return 1;
    } else if (a < 0) {
        return 2;
    } else {
        return 3;
    }
}

fn loop(n: i32, m: i32) i32 {
    var total: i32 = 0;
    var i: i32 = 0;
    while (i < n) : (i += 1) {
        while (total < m) {
            if (total == 7) {
                total = total + 2;
            }
            total = total + 1;
        }
    }
    return total;
}
