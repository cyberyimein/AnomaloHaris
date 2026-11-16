# Original Buddy cat frames

The 160 × 160 PNGs preserve the existing StackChan sprite art. Their source is
`MyStackChan/MystackChan/buddy_sprite_frames.h`: the original 4-bit packed
frame arrays and 16-color palette. Each packed byte stores the first pixel in
its high nibble and the next pixel in its low nibble. Palette index 0 is
rendered as the source generator's dark canvas color (`#080505`). The
`error_0.png` frame follows the original sprite table, which reuses
`BUDDY_DATA_APPROVAL_0` for its error pose.

Each `.rgb565` file is a big-endian RGB565 display buffer derived from its
matching PNG. `CatRenderer` loads each buffer once and stages it into the full
software framebuffer. The completed screen is submitted through native BMP
decoding; the native raw-buffer path produced incorrect physical output on
this device. Native-display fallback draws the original PNG. The pixel art is
not resized. Per-frame row offsets are baked into the opaque 160 × 160 canvas
so the chin baseline stays at row 123 while the image rectangle remains fixed:

| Frame | Row offset |
| --- | ---: |
| `idle_0`, `idle_1`, `think_0` | 0 |
| `think_1` | +1 |
| `touch_0` | +3 |
| `touch_1` | +5 |
| `sleep_0` | -6 |
| `error_0` | +4 |

The renderer centers the 160 × 160 rectangle using the display's reported
dimensions. Its position on the 320 × 240 CoreS3 display is `(80, 40)`. The
selected animation frames are:

| Device state | Frames |
| --- | --- |
| Booting, connecting, acting | `think_0`, `think_1` |
| Ready and idle | `idle_0`, `idle_1` |
| Touch | `touch_0`, `touch_1` |
| Sleeping | `sleep_0` |
| Error | `error_0` (the original approval sprite) |

The PNG previews under `MyStackChan/assets/buddy/generated/frames/` are not
used as firmware source because they are already scaled for preview. The
header frames retain the firmware's original 160 × 160 pixels and palette.
