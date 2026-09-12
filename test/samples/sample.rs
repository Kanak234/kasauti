fn classify(a: i32, b: i32) -> i32 {
    if a > 0 && b > 0 {
        1
    } else if a < 0 {
        2
    } else {
        3
    }
}

fn looper(n: i32, m: i32) -> i32 {
    let mut total = 0;
    for _i in 0..n {
        while total < m {
            if total == 7 {
                total = total + 2;
            }
            total = total + 1;
        }
    }
    total
}
