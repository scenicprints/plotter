import ast
import sys

p = "/home/jkevin/plotter/tools/plot"
s = open(p).read()

a = '''def run_vpype(svg, gcode, paper, margin, optimize, verbose, filter_min=None):
    cmd = [VPYPE, "--config", str(PROFILE), "read", str(svg)]'''
b = '''def run_vpype(svg, gcode, paper, margin, optimize, verbose, filter_min=None,
              merge_layers=True):
    cmd = [VPYPE, "--config", str(PROFILE), "read", str(svg)]
    if merge_layers:
        # Collapse every SVG layer into one. vpype optimises PER LAYER, so a
        # file with separate art/text layers is drawn art-first then
        # text-second, with no travel optimisation between them. Merging lets
        # linesort reorder across the whole drawing.
        cmd += ["lmove", "all", "1"]'''
if a not in s:
    print("ERROR: run_vpype signature not found")
    sys.exit(1)
s = s.replace(a, b)

a = '''    run_vpype(svg, gcode, paper, args.margin, not args.no_optimize, args.verbose,
              filter_min=args.filter_min)'''
b = '''    run_vpype(svg, gcode, paper, args.margin, not args.no_optimize, args.verbose,
              filter_min=args.filter_min, merge_layers=not args.keep_layers)'''
if a not in s:
    print("ERROR: run_vpype call not found")
    sys.exit(1)
s = s.replace(a, b)

a = '    ap.add_argument("--filter-min", default=None,'
b = ('    ap.add_argument("--keep-layers", action="store_true",\n'
     '                    help="keep SVG layers separate (drawn in order, e.g. for pen changes)")\n'
     '    ap.add_argument("--filter-min", default=None,')
if a not in s:
    print("ERROR: filter-min arg not found")
    sys.exit(1)
s = s.replace(a, b)

ast.parse(s)
open(p, "w").write(s)
print("patched: layers merged by default, --keep-layers to opt out")
