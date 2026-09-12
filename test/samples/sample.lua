function classify(a, b)
  if a > 0 and b > 0 then
    return 1
  elseif a < 0 then
    return 2
  else
    return 3
  end
end

function loop(n, m)
  local total = 0
  for i = 1, n do
    while total < m do
      if total == 7 then
        total = total + 2
      end
      total = total + 1
    end
  end
  return total
end
