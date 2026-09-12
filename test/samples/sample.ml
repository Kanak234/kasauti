let classify a b =
  if a > 0 && b > 0 then 1
  else if a < 0 then 2
  else 3

let loop n m =
  let total = ref 0 in
  for _i = 1 to n do
    while !total < m do
      if !total = 7 then total := !total + 2;
      total := !total + 1
    done
  done;
  !total
