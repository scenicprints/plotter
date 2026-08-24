import ast
import sys

p = "/home/jkevin/plotter/tools/plot"
s = open(p).read()

old = '''def make_dry(gcode, dry_path):
    out = []
    for line in gcode.read_text().splitlines():
        if line.strip() == "PEN_DOWN":
            out.append("; PEN_DOWN suppressed (dry run)")
        else:
            out.append(line)
    dry_path.write_text("\\n".join(out) + "\\n")'''

new = '''def make_dry(gcode, dry_path, dry_z=20.0):
    """Dry run: the pen never lowers AND rides high, so it clears corner
    magnets, clips and anything else standing proud of the bed."""
    out = []
    for line in gcode.read_text().splitlines():
        t = line.strip()
        if t == "PEN_DOWN":
            out.append("; PEN_DOWN suppressed (dry run)")
        elif t == "PEN_UP":
            out.append("G1 Z%.1f F900" % dry_z)
        else:
            out.append(line)
    dry_path.write_text("\\n".join(out) + "\\n")'''

if old not in s:
    print("ERROR: make_dry body not found")
    sys.exit(1)
s = s.replace(old, new)

a = '    ap.add_argument("-v", "--verbose", action="store_true")'
b = ('    ap.add_argument("--dry-z", type=float, default=20.0,\n'
     '                    help="height in mm the dry run flies at, to clear magnets etc")\n'
     '    ap.add_argument("-v", "--verbose", action="store_true")')
if a not in s:
    print("ERROR: verbose arg not found")
    sys.exit(1)
s = s.replace(a, b)

c = "        make_dry(gcode, dry)"
d = "        make_dry(gcode, dry, dry_z=args.dry_z)"
if c not in s:
    print("ERROR: make_dry call not found")
    sys.exit(1)
s = s.replace(c, d)

e = '        print("  dry run     : %s  (pen never lowers)" % dry.name)'
f = '        print("  dry run     : %s  (pen up, flying at Z%.0f)" % (dry.name, args.dry_z))'
if e in s:
    s = s.replace(e, f)

ast.parse(s)
open(p, "w").write(s)
print("patched: dry run flies high, --dry-z added")
