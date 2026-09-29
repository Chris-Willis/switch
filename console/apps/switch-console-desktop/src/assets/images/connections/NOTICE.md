# Connection logos

Brand logos shown on the Connections grid, one file per connection catalog
slug. All logos are trademarks of their respective owners and are used only to
identify the service a connection integrates with. Their use does not imply
endorsement by, or affiliation with, the owner.

The files are vendored so the app renders them offline. Each was reduced to its
`viewBox` and drawing paths: no scripts, external references, metadata or
embedded raster data. The single-colour marks draw in `currentColor`, and
`connection-icon.tsx` gives each its brand colour, switching to the brand's
one-colour black or white version on the theme where the colour would not
stand out from the tile.

All files fetched 2026-09-29.

| File | Brand | Source | License / terms | Colour |
|---|---|---|---|---|
| `github.svg` | GitHub | [Simple Icons](https://simpleicons.org) 16.33.0, `github` | CC0-1.0 ([Simple Icons disclaimer](https://github.com/simple-icons/simple-icons/blob/develop/DISCLAIMER.md)); brand guidelines https://github.com/logos | theme foreground |
| `jira.svg` | Jira | Simple Icons 16.33.0, `jira` | CC0-1.0; guidelines https://atlassian.design/foundations/logos/ | `#0052CC`, white in dark theme |
| `bitbucket.svg` | Bitbucket | Simple Icons 16.33.0, `bitbucket` | CC0-1.0; guidelines https://atlassian.design/foundations/logos/ | `#0052CC`, white in dark theme |
| `asana.svg` | Asana | Simple Icons 16.33.0, `asana` | CC0-1.0; guidelines https://asana.com/brand | `#F06A6A` |
| `gitlab.svg` | GitLab | Simple Icons 16.33.0, `gitlab` | CC0-1.0; guidelines https://about.gitlab.com/press/press-kit/ | `#FC6D26` |
| `google-workspace.svg` | Google | Simple Icons 16.33.0, `google` | CC0-1.0; guidelines https://about.google/brand-resource-center/brand-elements/ | `#4285F4` |
| `datadog.svg` | Datadog | Simple Icons 16.33.0, `datadog` | CC0-1.0; guidelines https://www.datadoghq.com/about/resources/ | `#632CA6`, white in dark theme |
| `new-relic.svg` | New Relic | Simple Icons 16.33.0, `newrelic` | CC0-1.0; guidelines https://newrelic.com/about/media-assets | black in light theme, `#1CE783` in dark theme |
| `notion.svg` | Notion | Simple Icons 16.33.0, `notion` | CC0-1.0 | theme foreground |
| `linear.svg` | Linear | Simple Icons 16.33.0, `linear` | CC0-1.0 | `#5E6AD2` |
| `box.svg` | Box | Simple Icons 16.33.0, `box` | CC0-1.0; guidelines https://www.box.com/en-gb/about-us/press | `#0061D5`, white in dark theme |
| `vercel.svg` | Vercel | Simple Icons 16.33.0, `vercel` | CC0-1.0; guidelines https://vercel.com/geist/brands | theme foreground |
| `canva.svg` | Canva | Canva "Icon logo" from https://www.canva.dev/assets/connect/Canva-logos.zip | Canva Connect brand guidelines (https://www.canva.dev/docs/connect/guidelines/brand/) permit the unmodified icon logo in an integration's UI; gradient ids renamed only | full colour, unmodified |

Simple Icons' CC0 dedication covers the drawings; it does not grant any
trademark rights, which remain with the owners.

## Not bundled

These catalog entries show their monogram instead of a logo:

- **Microsoft 365** (`microsoft-365`): no logo asset is bundled. Simple Icons
  removed all Microsoft marks at Microsoft's request
  (https://github.com/simple-icons/simple-icons/issues/11236). Microsoft's
  Trademark and Brand Guidelines say logos and icons "will require a license
  first" (https://www.microsoft.com/en-us/legal/intellectualproperty/trademarks).
- **Salesforce** (`salesforce`): no logo asset is bundled. Simple Icons removed
  it in v16.0.0 (https://github.com/simple-icons/simple-icons/releases/tag/16.0.0).
  Salesforce's Trademark & Copyright Usage Guidelines ask for a license or a
  signed permission form before its logos are displayed
  (https://www.salesforce.com/company/legal/intellectual/tmcusageguidelines/).

These notes record why this app does not bundle those two assets. They are not
a legal opinion on other uses.
