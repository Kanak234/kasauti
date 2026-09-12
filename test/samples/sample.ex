defmodule Sample do
  def classify(a, b) do
    cond do
      a > 0 and b > 0 -> 1
      a < 0 -> 2
      true -> 3
    end
  end

  def loop(n, m) do
    for i <- 1..n do
      if i > m and m > 0 do
        i
      else
        0
      end
    end
  end
end
