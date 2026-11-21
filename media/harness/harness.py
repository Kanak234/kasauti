# =============================================================================
# KASAUTI — media/harness/harness.py   (v2.0 "Parakh")
# -----------------------------------------------------------------------------
# WHAT:  The measuring instrument behind "Prove Complexity" and AI-fix
#        verification for Python. Two modes:
#          bench  — call ONE function at growing input sizes and time it
#          equiv  — call TWO versions on the same inputs and compare results
# WHY:   A Big-O claim from reading code is an estimate; running the code at
#        n = 16, 32, 64 ... and watching the time grow is evidence. And an AI
#        "optimisation" is only acceptable if it returns exactly what the
#        original returned — on edge cases too.
# FLOW:  src/prove/runner.ts spawns `python -c <this file>` in an empty temp
#        folder, writes ONE JSON request to stdin, and reads JSON LINES back.
#        Each bench point is printed and flushed immediately, so if a call
#        explodes (exponential code), the runner kills the process at its
#        timeout and still keeps every point measured so far.
# SAFETY: this runs user/AI code. The host only starts it after consent, in a
#        trusted workspace, after the static audit found no new security
#        findings, with a scrubbed environment and a hard timeout.
#        It is NOT a sandbox (SPEC OD-14).
# =============================================================================
import copy, json, math, random, sys, time


def emit(obj):
    """One JSON object per line, flushed — the runner may kill us any moment."""
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def load(code, fn):
    """Execute the extracted function source in a fresh namespace and return
    the function object. __name__ is not '__main__', so any
    `if __name__ == '__main__':` block in the snippet does not run."""
    ns = {"__name__": "__kasauti__"}
    exec(compile(code, "<kasauti>", "exec"), ns)
    if fn not in ns or not callable(ns[fn]):
        raise NameError("function %r is not defined by the code" % fn)
    return ns[fn]


def make(kind, n, rnd):
    """Build ONE argument tuple of size n for the chosen input shape.
    Values are small integers / short strings so equality is cheap and
    duplicates actually occur (they are where bugs hide)."""
    if kind == "list_int":
        return ([rnd.randint(-n, n) for _ in range(n)],)
    if kind == "sorted_list_int":
        return (sorted(rnd.randint(-n, n) for _ in range(n)),)
    if kind == "list_int_target":
        xs = [rnd.randint(-n, n) for _ in range(n)]
        return (xs, rnd.randint(-n, n))
    if kind == "two_lists":
        return ([rnd.randint(0, n) for _ in range(n)], [rnd.randint(0, n) for _ in range(n)])
    if kind == "string":
        return ("".join(rnd.choice("abcde ") for _ in range(n)),)
    if kind == "two_strings":
        return ("".join(rnd.choice("abc") for _ in range(n)), "".join(rnd.choice("abc") for _ in range(n)))
    if kind == "list_str":
        return (["".join(rnd.choice("abc") for _ in range(3)) for _ in range(n)],)
    if kind == "matrix":
        k = max(1, int(round(math.sqrt(n))))
        return ([[rnd.randint(0, 9) for _ in range(k)] for _ in range(k)],)
    if kind == "int":
        return (n,)
    raise ValueError("unknown input kind %r" % kind)


def edge_cases(kind):
    """Hand-picked inputs that break naive rewrites: empty, single, all-equal,
    negatives, already sorted, reversed."""
    if kind in ("list_int", "sorted_list_int"):
        return [([],), ([7],), ([3, 3, 3],), ([-1, -5, 0],), ([1, 2, 3, 4],), ([4, 3, 2, 1],)]
    if kind == "list_int_target":
        return [([], 1), ([5], 5), ([2, 2, 2], 2), ([1, -1], 0), ([1, 2, 3], 99)]
    if kind == "two_lists":
        return [([], []), ([1], []), ([], [1]), ([1, 1], [1]), ([3, 2, 1], [1, 2, 3])]
    if kind == "string":
        return [("",), ("a",), ("aaaa",), ("ab ba",), ("  ",)]
    if kind == "two_strings":
        return [("", ""), ("a", ""), ("", "a"), ("ab", "ba"), ("aaa", "aa")]
    if kind == "list_str":
        return [([],), (["a"],), (["a", "a"],), (["b", "a", "c"],)]
    if kind == "matrix":
        return [([[1]],), ([[1, 2], [3, 4]],), ([[0, 0], [0, 0]],)]
    if kind == "int":
        return [(0,), (1,), (2,), (3,), (10,)]
    return []


def call(f, args):
    """Run f on a deep copy (so in-place mutation cannot leak between runs).
    Returns ('ok', result, mutated_args) or ('err', exception_type_name, None)."""
    a = copy.deepcopy(args)
    try:
        return ("ok", f(*a), a)
    except Exception as e:  # noqa: BLE001 — we REPORT the error type, never hide it
        return ("err", type(e).__name__, None)


def same(x, y):
    """Equality that tolerates float rounding (an optimised sum may round
    differently in the last digit) but nothing else."""
    if isinstance(x, float) and isinstance(y, float):
        return math.isclose(x, y, rel_tol=1e-9, abs_tol=1e-12) or (math.isnan(x) and math.isnan(y))
    if isinstance(x, (list, tuple)) and isinstance(y, (list, tuple)) and type(x) == type(y):
        return len(x) == len(y) and all(same(a, b) for a, b in zip(x, y))
    try:
        return bool(x == y)
    except Exception:  # noqa: BLE001 — e.g. numpy arrays: fall back to text
        return repr(x) == repr(y)


def short(v, limit=200):
    r = repr(v)
    return r if len(r) <= limit else r[:limit] + "…"


def bench(req):
    f = load(req["code"], req["fn"])
    rnd = random.Random(req.get("seed", 7))
    budget = req.get("budgetSec", 1.0)          # stop growing once ONE call costs this much
    total_limit = req.get("totalSec", 15.0)      # and never measure for longer than this
    t_start = time.perf_counter()
    for n in req["sizes"]:
        args = make(req["kind"], n, rnd)
        best = None
        reps = 0
        spent = 0.0
        # Repeat fast calls (timer noise), keep the MINIMUM: the run least
        # disturbed by other processes is the closest to the true cost.
        while reps < 25 and (reps < 3 or spent < 0.05):
            a = copy.deepcopy(args)
            t0 = time.perf_counter()
            f(*a)
            dt = time.perf_counter() - t0
            best = dt if best is None else min(best, dt)
            spent += dt
            reps += 1
            if dt > budget:
                break
        emit({"type": "point", "n": n, "t": best, "reps": reps})
        if best > budget or time.perf_counter() - t_start > total_limit:
            break
    emit({"type": "done"})


def equiv(req):
    fa = load(req["codeA"], req["fn"])
    fb = load(req["codeB"], req["fn"])
    rnd = random.Random(req.get("seed", 11))
    cases = edge_cases(req["kind"]) + [make(req["kind"], n, rnd) for n in req.get("sizes", [0, 1, 2, 3, 5, 8, 13, 21, 50, 120])]
    checked = 0
    for args in cases:
        ra, rb = call(fa, args), call(fb, args)
        checked += 1
        ok = ra[0] == rb[0] and same(ra[1], rb[1]) and (ra[0] == "err" or same(ra[2], rb[2]))
        if not ok:
            emit({"type": "mismatch", "input": short(args), "original": short(ra[1]) if ra[0] == "ok" else "raised " + ra[1],
                  "candidate": short(rb[1]) if rb[0] == "ok" else "raised " + rb[1],
                  "sideEffect": ra[0] == rb[0] == "ok" and same(ra[1], rb[1])})
            break
    emit({"type": "done", "checked": checked})


def main():
    req = json.loads(sys.stdin.read())
    try:
        (bench if req["mode"] == "bench" else equiv)(req)
    except Exception as e:  # noqa: BLE001 — the host shows this message to the user
        emit({"type": "error", "error": "%s: %s" % (type(e).__name__, e)})


main()
