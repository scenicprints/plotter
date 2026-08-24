import ast
import sys

p = "/home/jkevin/plotter/tools/plot"
s = open(p).read()

# 1. --filter-min, applied inside the pipeline (round-tripping through a file
#    loses closed paths: vpype writes <polygon> and does not read it back)
a = '''def run_vpype(svg, gcode, paper, margin, optimize, verbose):
    cmd = [VPYPE, "--config", str(PROFILE), "read", str(svg)]'''
b = '''def run_vpype(svg, gcode, paper, margin, optimize, verbose, filter_min=None):
    cmd = [VPYPE, "--config", str(PROFILE), "read", str(svg)]
    if filter_min:
        # drop trace specks. must happen in-pipeline: writing an intermediate
        # SVG turns closed paths into <polygon>, which vpype cannot read back
        cmd += ["filter", "--min-length", filter_min]'''
if a not in s:
    print("ERROR: run_vpype signature not found")
    sys.exit(1)
s = s.replace(a, b)

a = "    run_vpype(svg, gcode, paper, args.margin, not args.no_optimize, args.verbose)"
b = "    run_vpype(svg, gcode, paper, args.margin, not args.no_optimize, args.verbose,\n              filter_min=args.filter_min)"
if a not in s:
    print("ERROR: run_vpype call not found")
    sys.exit(1)
s = s.replace(a, b)

a = '    ap.add_argument("--dry-z", type=float, default=20.0,'
b = ('    ap.add_argument("--filter-min", default=None,\n'
     '                    help="drop paths shorter than this, e.g. 1.5mm (trace specks)")\n'
     '    ap.add_argument("--dry-z", type=float, default=20.0,')
if a not in s:
    print("ERROR: dry-z arg not found")
    sys.exit(1)
s = s.replace(a, b)

# 2. real lift cost. the old flat 0.3s badly understates a 10mm lift.
a = '''def estimate(draw, travel, draw_f, travel_f, lift_s=0.30):
    dd = sum(math.hypot(s[2] - s[0], s[3] - s[1]) for s in draw)
    dt = sum(math.hypot(s[2] - s[0], s[3] - s[1]) for s in travel)
    secs = dd / (draw_f / 60.0) + dt / (travel_f / 60.0) + len(travel) * lift_s
    return dd, dt, len(travel), secs'''
b = '''def lift_cost():
    """Seconds for one pen up + down, from the machine's live settings.
    A 10mm lift at 900mm/min is 1.67s per path - with hundreds of paths this
    dominates the plot time, so it must not be a guessed constant."""
    try:
        url = MOONRAKER + "/printer/objects/query?gcode_macro%20_PLOT_VARS"
        raw = urllib.request.urlopen(url, timeout=10).read()
        st = json.loads(raw)["result"]["status"]["gcode_macro _PLOT_VARS"]
        lift = float(st.get("lift", 2.0))
        up = float(st.get("z_up_feed", 900.0))
        dn = float(st.get("z_down_feed", 600.0))
        return lift / (up / 60.0) + lift / (dn / 60.0), lift
    except Exception:
        return 0.6, None


def estimate(draw, travel, draw_f, travel_f, lift_s=None):
    if lift_s is None:
        lift_s = lift_cost()[0]
    dd = sum(math.hypot(s[2] - s[0], s[3] - s[1]) for s in draw)
    dt = sum(math.hypot(s[2] - s[0], s[3] - s[1]) for s in travel)
    secs = dd / (draw_f / 60.0) + dt / (travel_f / 60.0) + len(travel) * lift_s
    return dd, dt, len(travel), secs'''
if a not in s:
    print("ERROR: estimate not found")
    sys.exit(1)
s = s.replace(a, b)

# 3. show the lift cost so the trade-off is visible
a = '    print("  estimate    : %dm %ds" % (secs // 60, secs % 60))'
b = ('    lc, lh = lift_cost()\n'
     '    if lh is not None:\n'
     '        print("  lift cost   : %.2fs x %d paths = %dm %ds  (lift %.0fmm)"\n'
     '              % (lc, lifts, (lc * lifts) // 60, (lc * lifts) % 60, lh))\n'
     '    print("  estimate    : %dm %ds" % (secs // 60, secs % 60))')
if a not in s:
    print("ERROR: estimate print not found")
    sys.exit(1)
s = s.replace(a, b)

ast.parse(s)
open(p, "w").write(s)
print("patched: --filter-min in-pipeline, real lift cost in the estimate")
