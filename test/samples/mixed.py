def mixed(x, y, z):
    match x:
        case 1:
            return 1 if y else 2
        case _:
            pass
    try:
        do_it()
    except ValueError:
        if y and z or x:
            return 3
    return 0
