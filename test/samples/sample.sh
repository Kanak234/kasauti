classify() {
  if [[ $1 -gt 0 && $2 -gt 0 ]]; then
    echo 1
  elif [[ $1 -lt 0 ]]; then
    echo 2
  else
    echo 3
  fi
}

loop() {
  total=0
  for i in $(seq 1 "$1"); do
    while [ "$total" -lt "$2" ]; do
      if [ "$total" -eq 7 ]; then
        total=$((total + 2))
      fi
      total=$((total + 1))
    done
  done
  echo "$total"
}
