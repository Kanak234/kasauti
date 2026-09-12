class Sample {
public:
int classify(int a, int b) {
    if (a > 0 && b > 0) {
        return 1;
    } else if (a < 0) {
        return 2;
    } else {
        return 3;
    }
}
};

int loop(int n, int m) {
    int total = 0;
    for (int i = 0; i < n; i++) {
        while (total < m) {
            if (total == 7) {
                total = total + 2;
            }
            total = total + 1;
        }
    }
    return total;
}
