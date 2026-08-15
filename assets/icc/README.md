# The output profile

`ISOcoated_v2_eci.icc` is embedded as the `/DestOutputProfile` of every press
file this build writes. Its characterization data — the `targ` tag inside the
file — is `FOGRA39L, ISO 12647-2:2004/Amd 1`, which is exactly what Adobe's
tools label "Coated FOGRA39 (ISO 12647-2:2004)". It is the profile a Dhaka
press will recognise on sight.

**It is a default, not a measurement.** PRD §7 says to assume FOGRA39 until a
per-press ICC profile is confirmed, and to hold each press's actual profile in
its capability record once obtained. When that happens, this file is what gets
replaced — and `lib/pdf/cmyk.mjs` grows a real transform through it at the
same time. The separation there today is device-independent arithmetic, not a
colorimetric conversion, and swapping the profile without swapping that would
produce a file that claims a colour condition it does not honour.

## Licence

Governed by the Heidelberg ICC profile licence of September 2003, reproduced
in `LICENSE-Heidelberg-ICC.txt`, which must travel with the file. Clause 2.2
permits redistribution provided the licence goes with it; 3.1 forbids charging
for distributing the profile itself; 3.2 forbids editing the profile or its
tags. Debian ships this profile in `non-free` for those reasons — it is
redistributable, not open.

Source: ECI's `eci_offset_2009.zip` (https://www.eci.org/lib/exe/eci_offset_2009.zip).

## Why not the ICC registry's FOGRA39 profile

`Coated_Fogra39L_VIGC_300.icc`, from https://registry.color.org, carries a
cleaner licence — "may be used, embedded, exchanged, and shared without
restriction". It is also 8.65 MB, which lands in every generated PDF and turns
a business card into an 8 MB download on a mid-range Android phone over a
Dhaka mobile connection. That trade went the other way. If the licence terms
above ever become a problem, that profile is the drop-in replacement and the
only change is the filename in `lib/pdf/document.mjs`.
