package main

func classify(a int, b int) int {
	if a > 0 && b > 0 {
		return 1
	} else if a < 0 {
		return 2
	} else {
		return 3
	}
}

func loop(n, m int) int {
	total := 0
	for i := 0; i < n; i++ {
		for total < m {
			if total == 7 {
				total = total + 2
			}
			total = total + 1
		}
	}
	return total
}
