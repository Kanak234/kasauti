function mixed(x, y, z) {
  switch (x) {
    case 1:
      return y ? 1 : 2;
    case 2:
      break;
    default:
      break;
  }
  try {
    doit();
  } catch (e) {
    items.forEach((it) => {
      if (it && y || z) {
        log(it);
      }
    });
  }
  return 0;
}
