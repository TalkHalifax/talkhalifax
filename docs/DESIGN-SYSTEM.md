# TalkHalifax design system

_The rules the site is built on. The tokens live in `:root` at the top of `public/styles.css`; this file explains them.
Change a token there, not a colour in a rule._

## The idea

**White, frosted and quiet.** Home is a front page plus a feed on a near-white page: the developing stories pinned as
glass cards ("Developing"), the settled ones as a list ("Latest"), and a "Right now" side column on wide screens. Each
story is a room: the article on
the left, its live chat docked beside it. After dark the same system turns to **Charcoal**. Only the colour tokens change.
Colour is held back: ink on paper, with red and amber kept for warnings, and one "splash" colour still to be chosen.

It should feel native: on a phone like an app (no zoom, safe-area aware, sheets and drawers, 44px targets, pull to
refresh when added to the home screen), and on a desktop like a calm reading room with the conversation beside it.

## Colour tokens

| Token | Light | Charcoal | Use |
|---|---|---|---|
| `--surface-page` | `#f5f6f7` | `#1c1d1f` | Page background (also on `html`, so glass blurs the right colour) |
| `--surface-solid` | `#ffffff` | `#26282b` | Fields, solid panels |
| `--surface-sunken` | `#eef0f2` | `#18191b` | Chat bubbles, wells |
| `--surface-glass` | white 62% | `#2c2e32` 58% | Cards, header, chat (with `--glass-blur`) |
| `--surface-glass-hover` | white 82% | `#34373b` 72% | Hovered cards |
| `--edge-glass` | ink 7% | white 8% | Glass borders |
| `--line` | `#e3e5e8` | `#35383c` | Dividers |
| `--ink` | `#121417` | `#edeeef` | Text, primary buttons |
| `--ink-muted` | `#5b6168` | `#a3a8ae` | Secondary text |
| `--ink-faint` | `#7e848b` | `#7a7f86` | Hints, off switches |
| `--on-ink` | `#ffffff` | `#121417` | Text on an ink fill |
| `--signal-warn` | `#b3261e` | `#f2a49e` | Warnings, errors, LIVE |
| `--signal-caution` | `#8a5a00` | `#e8be6a` | Watches, advisories |
| `--signal-ok` | `#1d6a86` | `#8ecbe0` | Confirmations |
| `--banner-warn` | `#fbeceb` | `#3a2422` | Solid band behind a city notice or weather warning |
| `--banner-caution` | `#f7f0e3` | `#332b1b` | Solid band behind a watch or statement |
| `--splash` | = `--ink` | = `--ink` | The accent. Points at ink until a brand colour is chosen |

Older names (`--bg`, `--glass`, `--muted`, `--accent`, `--warn`, …) are aliases of these. New code uses the new names.

Rules:
- Text on any surface meets WCAG AA (4.5:1 body, 3:1 large). Check both themes when adding a colour.
- Signal colours mean something. Never use red or amber for decoration.
- `--signal-warn` is for warnings, errors and LIVE, never "Updated". An updated stamp is `--ink` at 600.
- Alert banners are solid, never glass, so they read at a glance over anything.

## Type

| Role | Font | Use |
|---|---|---|
| Display `--f-display` | Inter Tight 600/700 | Page titles (32px), section titles (28px), the wordmark (21px), card headlines |
| Body `--f-body` | Inter 400–700, 16px / 1.55 | Everything else |
| Reading `--f-read` | Inter | Deks (19px / 1.45) and story body |
| Mono `--f-mono` | JetBrains Mono | Bylines, times, roles, small data |

Headlines use `letter-spacing: -.025em` and `text-wrap: balance`. Labels (kickers, section heads) are 12px, 600,
uppercase, `.1em` tracking. Reading width stays under about 68ch.

## Shape, depth, motion

- Radii: `--radius-s` 8px (small controls), `--radius-m` 12px (buttons, banners), `--radius-l` 18px (cards, forms);
  pills are fully round.
- Depth comes from glass (`--shadow-glass`, `--glass-blur: blur(20px) saturate(1.2)`), not heavy shadows.
- Motion is short and functional: the chat sliding, an update flashing, pull to refresh. Everything has a
  `prefers-reduced-motion: reduce` fallback.

## Layout and breakpoints

| Width | Layout |
|---|---|
| ≥ 1024px | Home is two columns, the main column plus the 320px "Right now" column on the right (32px gap, top-aligned), when the side column has content; otherwise the main column fills the width |
| < 1024px | Home is one column; "Right now" stacks below the main column (36px above it) |
| ≥ 960px | Story with the chat docked on the right (`--chatw` 400px), full header nav |
| < 960px | The chat becomes a bottom sheet; its header bar toggles it |
| < 760px | Header sections move into the drawer behind the profile button |
| < 560px | Phone spacing: tighter gutters, smaller section titles, shallower reply indents |

Home content is at most `--page-max` (1200px) wide, centred. The lead story card spans the full row at every width.

Page gutters are `max(28px, safe-area inset)`. The viewport disables pinch zoom (it's an app-like surface), so
text sizes must already be readable: 16px body minimum on inputs to stop iOS zooming.

## Components

| Component | Class | Notes |
|---|---|---|
| Header | `header`, `.name`, `.hnav`, `.me-btn` | Sticky glass bar under the safe area; the profile button opens the drawer |
| Transit map | `.tr-*` (styles in `public/transit.js`) | Map and glass side panel. Under 760px the map fills the screen below the header, with the route bar and a details sheet floating on it as glass (service alerts start folded). Buses are `--ink` markers with a direction pointer, ferries `--signal-ok`. Positron or Dark map style follows the colour scheme |
| Events | `.ev-*` (styles in `public/events.js`) | Filter chips (`.nfilters`) for when and who, an area select, Highlights as story cards (photo only when the library has a real one, not its stock banners), then a day-by-day list: time, title, branch, audience pill, caution-coloured flags (Registration required, Full), Cancelled in warn colour and struck through. A row opens in place with details and the library link. Under 760px the chips scroll sideways |
| Alerts | `.al-*` (styles in `public/alerts.js`) | A section of the profile, "Alerts on this device" (signed in or not; `#alerts` links scroll to it): kinds as 44px checkboxes, quiet hours with hour selects, one ink button. `.al-offer` is the glass offer under a notice |
| Offline bar | `.offline-bar` | Sticky caution band under the header while there's no connection |
| Weather line | `.wx` | 24px line icon (`--ink`) and 13px muted text, left of the sections on desktop; the "Feels like" words drop under 960px; at the bottom of the menu on phones. A link to Environment Canada, with the full reading in its label |
| Install card | `.install` dialog | Opened by Install the app where the browser has no install prompt (iPhone and iPad always). Numbered steps with the Share or ⋮ icon drawn inline; tap outside or × to close |
| Global footer | `.site-foot` | Anchored to the bottom (the body is a full-height column and `main` grows), on every view (hidden under the full-screen Transit map on phones) on the sunken surface. The brand row (app icon, wordmark, one line) sits beside three columns: Read (every section), Stay in the loop (Get alerts; Install the app, on phones and wherever the browser offers its install prompt, hidden inside the installed app; profile; privacy) and Our sources (official sites, ↗ external). The fine print sits under a hairline and ends with the site version (`v<PR number>` live, `dev` locally) in mono at 12px, `--ink-muted`. Four columns on desktop; two under 860px, with sources full width under 560px. Clears the docked chat |
| App icon | `public/icons/` | A Halifax skyline (lighthouse, the Macdonald Bridge, City Hall's clock tower, the Dominion Building, a church spire, towers behind) over the harbour, navy on pale blue, no words. Rounded for `any`; full-bleed with the skyline inside the 80% safe zone for `maskable`; square for Apple's touch icon; the 32 px favicon is cropped to the bridge and clock tower |
| Drawer | `.drawer`, `.dr-*` | Phone navigation and account, a native `<dialog>` |
| Home layout | `.home-grid`, `.home-main`, `.home-sec`, `.home-rail`, `.rail-body` | `.home-grid` (max `--page-max`, centred) holds `.home-main` and the `.home-rail` aside ("Right now", `#homeRail`, labelled by `#railH`, body `#railBody`). In `.home-main`, sections `#pinsSec` ("Developing", cards in `#pins`, count in `#pinsCount`) and `#feedSec` ("Latest", rows in `#feed`) sit 36px apart. Every region carries `hidden` until Home fills it, so an empty one takes no space. The page's only heading until then is a visually hidden h1 (`.sr`). `#devCards` is legacy; Home hides and empties it on render. Pins are in `#pins` (count `#pinsCount`), the feed in `#feed`, the rail in `#homeRail` / `#railBody`, labelled by `#railH` |
| Right now rail | `.home-rail`, `.rail-body` | Up to three blocks, in order: Weather (current conditions, linking to Environment Canada; left out when the reading is over 3 hours old), Weather watches and statements (warnings stay in the alert bar), and Notices (up to 3, then "All notices"). Each block is a 13px Inter 600 `--ink` h3 sub-head over a `.feed`, 24px between blocks; an empty block is left out. Rows always use the two-line feed layout (type and stamp, headline below). "All notices" is a 44px target with its own 2px `--focus` ring |
| Section head | `.sec-head`, `.sec-count` | The label style: 12px Inter 600, uppercase, `.1em` tracking, `--ink-muted`. `.sec-count` beside it in 12px mono, tabular, hidden while empty. A head with `.live-h` shows LIVE (12px, 700, `--signal-warn`) only when its `.home-sec` holds a developing (non-archived) card |
| Feed row | `.feed`, `.feed-row` | A list under a hairline, one row per story: `.pill` as the type label, headline (`.tt`, display 600 16px, balanced) and `.stamp`. At least 44px tall, underline on hover, its own 2px `--focus` outline. Under 560px the type and stamp share the first line with the headline below; inside the rail (`.rail-body`) that two-line layout applies at every width. An empty `.feed` takes no space |
| Timestamp | `.stamp` | 12.5px mono, tabular, `--ink-muted`, never wraps |
| Story card | `.card` (`.lead` spans the full row) | Glass; kicker, headline, dek, pills, live viewer count. On Home the headline is the display face with `text-wrap: balance` (lead 700/28px, others 600/17px). `.upd` (a recent update) is `--ink` at 600, not red. The live viewer icon is `--signal-warn` |
| Card footer group | `.ft-start` | Inside `.ft`, groups the stamp and pill on the left; the viewer count after it is pushed right |
| Pill | `.pill` | Status labels (LIVE, Update, area) |
| Alert banner | `.abar` | Solid band on Home for city notices and weather warnings |
| Byline | `.byline` | Author, date, read time, then the AI disclosure linking to the source. An "Updated" time only if the story has really changed |
| What to do | `.todo` | Solid card under the byline with the reader's actions. Left out when there are none |
| Facts | `.facts` | Compact label/value list, copied facts only: under "What to do" on a notice, as "Key details" (`.key-details`) below the story on an article |
| Story subheading | `.body h2` | From a body string starting `## ` |
| Byline | `.byline`, `.author-card` | Mono; links to the author's profile |
| Chat | `.chat`, `.msgs`, `.grp`, `.bubble`, `.composer`, `.send` | Docked on desktop, sheet on mobile |
| Comments | `.comments-sec`, `.cm`, `.creplies` | Archived articles, threaded one level |
| Button | `.btn`, `.send`, `.danger-btn` | 44px minimum; ink fill for the main action |
| Switch | `.switch` | Settings |
| Forms | `.auth-form`, `.auth-err` (`.ok`), `.ts-box` | Sign-in, sign-up with Turnstile, reset |
| Moderation | `.report`, `.mod-tools`, `.rep-done`, `.reset-link` | Moderators only |
| Legal | `.legal` | Privacy page reading width |
| Admin site | `public/admin.css` in the admin repo | Its own small stylesheet on the same tokens: a centred sign-in card (`.signin`), side menu with Sign out that stacks on phones, glass cards, wide lists that scroll inside their card. Charts use `--ink` only, one measure per plot with a shared zero baseline; hover shows the exact value and every chart can show as a table |

### Site version

The footer's `v<N>` and the service worker's build name are stamped at deploy:

- The stamp runs in the deploy job only, after checkout and before `wrangler deploy`, never in `check`, and it's never committed.
- The value is `v<N>` (`^v[0-9]+$`). N comes from the merge commit subject "Merge pull request #N" (or a squash subject ending "(#N)").
- It replaces `dev` with `v<N>` inside `<span class="sf-ver" id="sfVer">dev</span>` in `public/index.html` and inside `const BUILD = "dev";` in `public/sw.js`, giving `<span class="sf-ver" id="sfVer">v54</span>` and `const BUILD = "v54";`. Each string must occur exactly once, otherwise the step fails.
- Unstamped is `dev`. Saved stories live in the fixed `th-v7-data` cache, which never follows the version. The `th-vN` base is still bumped by hand when the cache layout changes.

## Voice in the interface

Plain Canadian English, short and specific. Say what happened and what to do: "That wasn't posted: phone numbers can't
be shared here, to keep people safe." No exclamation marks, no "Oops", no em dashes. Buttons name the action
("Remove it", "Make a password reset link").

## Accessibility checklist

- Every control 44×44px minimum, a visible `:focus-visible` ring, keyboard-reachable.
- Colour never carries meaning alone (warnings also say "Warning").
- Live regions for chat and updates; `prefers-reduced-motion` respected.
- Both themes checked at 375px and 1440px before shipping a visual change.

## Next for the native experience

- Choose the `--splash` brand colour.
- A small component page (`/#styleguide`, moderators only) that renders every component in both themes, for review.
