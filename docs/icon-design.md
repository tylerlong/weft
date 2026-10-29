# Weft icon design

## Status

These are subjective working preferences for exploration, not hard requirements or permanent brand rules. Any choice can change after seeing concepts or using the icon. The user explicitly requested this flexibility, including whether to use a W at all. Agreement authorizes exploring an idea; it does not select it as the final design.

## First version

The user chose to implement the woven W from the copper-background concept as a first version, wire it into both the website and desktop app, and commit its source and exports. This is a practical starting point, not a permanent brand decision.
- Source: `assets/icons/weft.svg`.
- Exports: `assets/icons/weft-1024.png` and `assets/icons/weft.icns`.
- Solid copper tile: `#a85e39`; ivory mark: `#f5efe4`; transparent outside the rounded tile.
- The SVG is a clean vector reconstruction of the generated concept, not a raster image embedded in SVG.
- The website uses the SVG favicon; desktop packaging uses the ICNS export.

The PNG was rendered from the SVG with Chromium at 1024×1024 and a transparent page background. The ICNS contains the standard 16, 32, 128, 256 and 512 point entries at 1× and 2×, resized with macOS `sips` and assembled with `iconutil`. Regenerate both exports after changing the SVG.

## Exploration history

- A woven W with broad strands and few crossings is one candidate. Non-letter symbols and other metaphors remain open.
- A calm, precise, crafted character with clean geometry and softened corners is a starting point.
- One core symbol adapted for app and website sizes is a starting point.
- Keep the favicon recognizable at 16–32 pixels; the desktop icon can use a fuller treatment.
- Compare muted copper, teal, and monochrome across dark ink, warm ivory, and a colored background. Amber on ink was an initial suggestion, not a selected palette.
- Flat, broad ribbons and over/under gaps are one treatment to explore.
- Favor a distinct visual identity; the user wants to avoid strong resemblance to famous app icons, specifically Microsoft Word. Reconsider the W if it creates that association.

## Future exploration

- Use a temporary consistent mark for color comparisons; that does not select the mark.
- Explore both W and non-letter geometries before selecting or revising a concept.
- Revisit palette, treatment, or metaphor if the visual results suggest a better direction.
- Validate small-size legibility before producing final app and website assets.
- Compare concepts with recognizable existing app icons; no distinctiveness or trademark clearance has been established.

The first version does not establish uniqueness or trademark clearance.

## First-version verification

- Inspected browser renders at 16, 32, 64, and 128 pixels.
- Verified the 1024-pixel PNG's dimensions, transparent corners, and copper fill.
- Built the website and fetched its emitted SVG favicon successfully over HTTP.
- Built an isolated macOS Electron package and verified its declared icon matches the committed ICNS bytes.
- The full desktop acceptance test was blocked by the existing running-app guard because Weft was running. No running application was stopped; the rebuilt application's Dock appearance remains unverified.
