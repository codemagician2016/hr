# Sitepresso — Brand Guide

**Tagline:** Websites in 5 minutes
**Palette:** Indigo + Violet (Premium)

---

## Logo Files

| File | Use Case |
|---|---|
| `sitepresso-logo.svg` | Wordmark + icon, light mode (use on white/light backgrounds) |
| `sitepresso-logo-darkmode.svg` | Wordmark + icon, dark mode (use on dark backgrounds) |
| `sitepresso-icon.svg` | Icon only — favicons, app icons, social avatars |

---

## Color Palette

### Primary

| Name | HEX | Tailwind | Usage |
|---|---|---|---|
| Violet 500 | `#8B5CF6` | `violet-500` | Primary brand color, CTAs, accents |
| Violet 900 | `#4C1D95` | `violet-900` | Gradient end, hover states |
| Indigo 950 | `#1E1B4B` | `indigo-950` | Dark text, headers, dark backgrounds |

### Supporting

| Name | HEX | Tailwind |
|---|---|---|
| Violet 400 | `#A78BFA` | `violet-400` |
| Violet 300 | `#C4B5FD` | `violet-300` |
| Violet 100 | `#EDE9FE` | `violet-100` |
| Violet 50 | `#F5F3FF` | `violet-50` |

### Neutrals

| Name | HEX | Tailwind |
|---|---|---|
| Slate 800 | `#1F2937` | `slate-800` (body text) |
| Slate 500 | `#6B7280` | `slate-500` (secondary) |
| Slate 400 | `#9CA3AF` | `slate-400` (muted on dark) |
| White | `#FFFFFF` | `white` |

---

## Gradient

```css
background: linear-gradient(135deg, #8B5CF6 0%, #4C1D95 100%);
```

Tailwind:
```html
<div class="bg-gradient-to-br from-violet-500 to-violet-900"></div>
```

---

## Typography

**Stack:** `-apple-system, "Segoe UI", Helvetica, Arial, sans-serif`

| Use | Weight | Notes |
|---|---|---|
| Wordmark | 800 (Extra Bold) | Letter-spacing: -1.5px |
| Headings | 700 (Bold) | Tight tracking |
| Body | 400-500 | Regular reading |
| Tagline / Caption | 500 | Letter-spacing: 2px, uppercase |

---

## Logo Usage Rules

**Do:**
- Maintain clear space equal to the height of the cup icon on all sides
- Use dark-mode version on backgrounds darker than `#4C1D95`
- Use icon-only version when space is tight

**Don't:**
- Recolor the wordmark outside the brand palette
- Stretch, skew, or rotate the logo
- Place light-mode logo on busy or low-contrast backgrounds
- Add drop shadows or effects to the mark
