def classify(a, b):
    if a > 0 and b > 0:
        return 1
    elif a < 0:
        return 2
    else:
        return 3


def loop(n, m):
    total = 0
    for i in range(n):
        while total < m:
            if total == 7:
                total = total + 2
            total = total + 1
    return total
