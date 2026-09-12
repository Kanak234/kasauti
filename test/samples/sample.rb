def classify(a, b)
  if a > 0 && b > 0
    1
  elsif a < 0
    2
  else
    3
  end
end

def loop(n, m)
  total = 0
  for i in 0...n
    while total < m
      if total == 7
        total = total + 2
      end
      total = total + 1
    end
  end
  total
end
