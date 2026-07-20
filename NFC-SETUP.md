# NFC tag setup

Everything here is about one goal: a stranger taps a phone on your object and a
web page opens. No app, no instructions on a placard, no failed taps.

## The short version

Write an **NDEF URI record** containing an `https://` URL to an **NTAG213**
sticker. That's it — both iOS and Android read NDEF URI records natively and
show a tap-to-open notification without any app installed.

## Which tag to buy

For a print you're placing in a gallery, the chip matters less than the form
factor, but here's the tradeoff:

| Chip | User memory | URL budget | Notes |
|---|---|---|---|
| **NTAG213** | 144 bytes | ~130 chars | The default. Cheap, universally read. |
| NTAG215 | 504 bytes | ~490 chars | Only if you want extra records. |
| NTAG216 | 888 bytes | ~870 chars | Overkill here. |

All three are ISO 14443A / NFC Forum Type 2 at 13.56 MHz and work identically
for this purpose. **Avoid** Mifare Classic 1K — it's technically writable with
NDEF but iPhones will not read it reliably.

Get **25 mm round wet-inlay stickers** with a paper or PET face. Larger antenna
means a longer read range and more forgiving tap placement, which matters a lot
when the person tapping has never done this before.

### What kills a tag

- **Metal directly behind the antenna.** It detunes the coil and the tag goes
  dead. If you're mounting on or near metal, buy "on-metal" / ferrite-backed
  tags specifically.
- **Depth.** PLA, PETG and ABS are transparent to 13.56 MHz, so embedding a tag
  inside a print is fine — but keep it within about 3–5 mm of the surface. Much
  deeper and the read range drops below what a phone will manage.
- **Carbon-fibre-filled filament.** It's conductive enough to attenuate badly.
  Test before committing.

### Embedding the tag inside the print

Nicer than a sticker for an exhibition piece. In your slicer, add a pause at
the layer that leaves a shallow pocket, drop the tag in face-up, and resume.
PrusaSlicer/Orca: right-click the layer slider → *Add pause print (M601)*.
Design the pocket ~0.4 mm deeper than the tag and slightly oversized; the tag is
thin enough that a single solid layer over the top will bridge cleanly.

## The URL

**Keep it short.** Not because 144 bytes is tight, but because short URLs are
robust and you may want to print the same link as a QR code fallback.

```
https://haddy.life/rock-work/
```

Each piece gets its own showcase page, so one tag points at one piece's URL. (The
toolpath viewer that page embeds still uses `?p=<id>` against
`web/data/manifest.json` under the hood — see `viewer.html`.)

Notes on the URL:

- **Must be `https://`.** iOS will not surface a tap notification for `http://`
  in the way you want, and you'll be on a public network.
- **No redirects if you can avoid it.** A URL shortener adds a round trip on a
  slow connection and a chance of failure, right at the moment the person is
  deciding whether this is worth their attention.
- **No custom URI scheme.** `myapp://` would defeat the entire zero-install
  requirement.

## The NDEF record

You almost certainly don't need to hand-build this — the apps below do it — but
knowing the structure helps when you're debugging a tag that doesn't work.

A URI record compresses the common prefix into a single byte, which is why
`https://` costs you 1 byte instead of 8:

| Prefix byte | Expands to |
|---|---|
| `0x00` | (none — full URI follows) |
| `0x01` | `http://www.` |
| `0x02` | `https://www.` |
| `0x03` | `http://` |
| **`0x04`** | **`https://`** ← use this one |

So `https://haddy.life/rock-work` is stored as `0x04` followed by the ASCII bytes
of `haddy.life/rock-work`.

Wrapped as a complete NDEF message:

```
D1                          TNF=0x01 (well-known), MB, ME, SR set
01                          type length = 1
15                          payload length = 21
55                          type = 'U' (URI)
04                          prefix = https://
68 61 64 64 79 ...          "haddy.life/rock-work"
```

Write **one record only**. Multi-record messages work but some readers surface
only the first, and there's no second thing you want here.

## Writing the tag

Use a phone app — a USB reader/writer is unnecessary for a handful of tags.

- **Android:** [NFC Tools](https://play.google.com/store/apps/details?id=com.wakdev.wdnfc)
  (free). *Write* → *Add a record* → *URL/URI* → paste → *Write*.
- **iOS:** [NFC Tools for iOS](https://apps.apple.com/app/nfc-tools/id1252962749).
  Same flow. iPhones have been able to write NDEF since iOS 13.

Then **lock the tag** — set it read-only once you've tested. In NFC Tools this
is *Other* → *Make read-only*. It's irreversible, so test first, but an unlocked
tag in a public space can be rewritten by any passerby with the same free app.

## How phones actually behave

This is the part that determines whether your piece works, and it's worth
knowing before you're standing in the gallery.

**Android.** Background NFC reading is always on when the screen is unlocked.
Tap → a notification appears → the user taps it → browser opens. Some launchers
open the URL directly. The antenna is usually in the upper-middle of the back.

**iPhone XS and newer (iOS 13+).** Background tag reading works with the screen
on and unlocked, no app needed. A banner slides down from the top; tapping it
opens Safari. **The antenna is at the very top edge of the back of the phone**,
which is the single most common reason a tap "doesn't work" — people
instinctively present the middle of the phone.

**iPhone 7, 8, X.** These need NFC scanning invoked manually from Control
Centre. In practice, assume they won't work.

**Screen must be on and unlocked** on every platform. A phone in a pocket won't
read anything.

### Design around it

Since a meaningful fraction of taps will fail on the first try through no fault
of the tag, put a small label next to the piece:

> **Tap here with your phone** — hold the top of your phone against the mark.
> Or scan: [QR code]

The QR code costs nothing, works on every phone including old iPhones and
Androids with NFC off, and rescues anyone the tag fails. Generate it for the
identical URL. Treat NFC as the delightful path and QR as the reliable one.

## Testing checklist

Before the show, with a phone you did *not* use to write the tag:

- [ ] Tap with the screen on and unlocked → notification appears
- [ ] Opening the notification loads the page over **cellular**, not gallery wifi
- [ ] Page renders and the slider responds within a few seconds on a cold cache
- [ ] Test on both an iPhone and an Android
- [ ] Test through whatever the tag is actually mounted under or inside
- [ ] Tag is locked read-only
- [ ] QR fallback resolves to the same URL
