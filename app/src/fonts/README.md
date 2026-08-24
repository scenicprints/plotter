# Single-stroke fonts

Each glyph here is the path a pen travels, not an outline to be filled. A normal
font's `o` is two closed curves; plotting one draws a hollow ring. These draw a
circle.

Taken from Inkscape's Hershey Text extension so the app carries its own copies
and does not depend on Inkscape being installed.

- **EMS\*** — SIL Open Font License 1.1, see `OFL.txt`.
- **Hershey\*** — the Hershey Fonts, free for any use provided the original
  acknowledgements travel with them. They are in the `<metadata>` of each file,
  which is why these are kept whole rather than minified.

Format is SVG Fonts: `<font-face units-per-em>` plus `<glyph unicode
horiz-adv-x d>`. `src/core/strokefont.js` reads them directly.
