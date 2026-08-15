# Vendored faces

These are the binaries `lib/pdf` outlines from when it writes a press file.
They are checked in rather than fetched at render time because a PDF/X-4 is
built from whatever is on disk: if the binary arrived over the network, a
reissue upstream would shift the metrics by a hair and the cards printed on
Tuesday would stop matching the cards printed on Monday. Pinning them is what
makes the writer a pure function of the spec.

Every family is SIL Open Font License 1.1, which is a hard library policy
rather than a preference — PRD §7 and blueprint F13 require it, because the
output outlines glyphs and an outline is a derivative of the face. Each
family's `OFL.txt` sits beside its binaries and must stay there.

| Family | Weights | Role |
| --- | --- | --- |
| Archivo | 400 600 700 800 | Latin — `typ.noto`, `typ.baloo` |
| Libre Franklin | 400 600 700 800 | Latin — `typ.siliguri` |
| Playfair Display | 400 600 700 800 | Latin — `typ.tiro` |
| IBM Plex Mono | 400 600 700 | Latin — `typ.mono` (no 800 is published) |
| Hind Siliguri | 400 600 700 | Bangla — `typ.siliguri` |
| Noto Sans Bengali | 400 600 700 800 | Bangla — `typ.noto`, `typ.mono` |
| Tiro Bangla | 400 | Bangla — `typ.tiro` (no other weight is published) |
| Baloo Da 2 | 400 600 700 800 | Bangla — `typ.baloo` |

A requested weight that is not published resolves to the nearest one that is,
which is what a browser does, so the printed card matches the proof the
customer approved. What the writer will not do is synthesise the missing
weight by stroking the outline — a faux-bold plate is a fabrication.

The Bangla faces are vendored and are not yet used: `lib/pdf/text.mjs` refuses
Bangla runs, because conjuncts and matras are formed by GSUB shaping and this
writer maps codepoints to glyphs one at a time. They are here so that the only
thing missing is the shaper.

Refresh with:

    node lib/pdf/vendor-fonts.mjs assets/fonts

The subsets are Google's `latin,latin-ext` and, for the Bangla families,
`bengali` as well. A character outside the vendored subset is a refusal naming
the codepoint, never a `.notdef` box on a printed card.
