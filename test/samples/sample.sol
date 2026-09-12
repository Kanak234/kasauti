pragma solidity ^0.8.0;

contract Sample {
    function classify(int a, int b) public pure returns (int) {
        if (a > 0 && b > 0) {
            return 1;
        } else if (a < 0) {
            return 2;
        } else {
            return 3;
        }
    }

    function loop(uint n, uint m) public pure returns (uint) {
        uint total = 0;
        for (uint i = 0; i < n; i++) {
            while (total < m) {
                if (total == 7) {
                    total = total + 2;
                }
                total = total + 1;
            }
        }
        return total;
    }
}
