# Visual identity

`public/mark.svg` is an original vector drawing. A P retains the initial of Pactspan; its lower crossbar extends to a second upright, forming a span. The continuous shape refers to the link between an agreement and its version history. It is an identifier, not a status or a verification badge.

The SVG has a 64×64 viewBox. Its main strokes are 7 units wide, its counter is 12 units high, and both uprights end at y49. At 16px this leaves a 1.75px stroke and a 3px open counter. The drawing uses filled paths with no fonts, raster content, scripts, filters or external assets. Keep its aspect ratio and display at 16, 24 or 40px; use the product name beside it when identification would otherwise be unclear.

The tile uses cool neutral colors with a local deterministic gradient and a narrow inset highlight. The foreground is a single slate-blue fill, `#344e6a`. The material treatment belongs to the background only. Avoid extra glow, animated reflections or texture.

For a monochrome rendering, retain `#pactspan-glyph`, remove `#pactspan-background` and the definitions, and replace the foreground fill with the surrounding text color. The complete silhouette, open counter and two uprights remain without the tile. A dark surface needs a light foreground; do not apply the dark default fill directly to a dark surface.

The accessible SVG title is `Pactspan`. When used next to an identical visible text label, the embedding interface may hide the image from assistive technology to avoid repeating the name. Do not use the mark alone to convey confirmed, disputed or fulfilled state; show a text label for the actual state.
