# Sheet Music Player

Take a photo of sheet music (one page or several), and get a real, editable score you can play back.

- **Scan**: photograph pages with your phone (or pick photos). Claude reads every note, rest, tie, chord symbol, lyric, repeat and D.C./coda mark, and multi-page pieces are stitched together (pages with printed numbers are sorted automatically).
- **See it**: the music is engraved properly (OpenSheetMusicDisplay), with lyrics, chord symbols, dynamics and articulations.
- **Hear it**: a sampled grand piano (Salamander) with reverb, dynamics, accents, staccato, slurs and a light human feel. Other parts can use voice, flute, strings, organ, music box, marimba, guitar or bass sounds. Repeats, 1st/2nd endings, D.C./D.S. al Fine/Coda are followed. Notes light up as they play and the page follows along.
- **Practice**: tempo slider (25–200%), metronome, one-bar count-in, loop any range of measures, tap a measure to start there, mute/solo/volume per part.
- **Edit**: tap a note to change its pitch, duration, accidental, ties, articulations, dynamics and lyrics; add chord notes or a second voice; insert/delete/copy/paste measures; add chord symbols, repeats, endings, jumps, tempo and key changes; undo/redo.
- **Transpose** by any interval or to any key (key signatures, note spelling and chord symbols all follow), or shift a single part by octaves.
- **Play along on your own piano**: a large, distraction-free view (white, cream or dark paper) that keeps the screen awake. Turn pages by tapping either side, with the arrow keys, or with a Bluetooth page-turner pedal.
  - *Play along*: the app plays the other hand or the other parts while the music scrolls and the keys you need light up.
  - *Wait for me*: the music waits on each note until you play it, using a USB/Bluetooth **MIDI** digital piano (Chrome, Edge, Android), or, as an experiment, the **microphone** with an acoustic piano.
  - It shows the name of the chord you're holding on a MIDI keyboard.
- **Chords**: printed chord symbols are read when scanning. For music without them, **Detect chords** works them out from the notes (slash chords included). They transpose with the music and can play softly along.
- **Print**: a print view with real Letter/A4 pages, adjustable staff size, and a choice of parts, chord symbols, lyrics, title and measure numbers. It prints what's on screen, so it uses your transposed key and your fixes. Use "Save as PDF" in the print dialog to get a file.
- **Import**: MusicXML (`.musicxml`, `.mxl`, `.xml`), MIDI, ABC, PDF (pages go to the scanner) and images.
- **Find music**: search **The Session** (thousands of folk tunes with chords) and import with one tap. Search **IMSLP** (public-domain classical scores) and get its PDF/MIDI/MusicXML files, with links to more sources.
- **Export** MusicXML (opens in MuseScore, Finale, Sibelius, Dorico…), MIDI, the app's own `.json`, or print to PDF. Scores are saved automatically in your browser.

## Run it

Requires Node 20+.

```bash
npm install
npm run dev          # app on http://localhost:5173 (also on your local network) + API server
```

Open the printed **Network** address on your phone (same Wi-Fi) to use the camera.

Production:

```bash
npm run build
ANTHROPIC_API_KEY=sk-ant-... npm start      # serves the app + API on http://localhost:8080
```

### Claude API key

Scanning uses the Claude API (model `claude-opus-5-5` by default). There are two ways to give it a key:

1. **On the server** – set `ANTHROPIC_API_KEY` when running `npm run dev` / `npm start`. The key never reaches the browser.
2. **In the browser** – open **Settings** in the app and paste your key. It is stored only in that browser and sent only to Anthropic. This is what makes the static GitHub Pages version work.

Each page costs roughly a few tens of cents with Opus 5.5 at the default "Careful" accuracy (one high-resolution image in, a few thousand tokens of notes and reasoning out). "Quick" is cheaper and faster; Settings also lets you switch to Claude Sonnet 5.5. A dense page usually takes 1–4 minutes. Requests opt in to server-side fallback (`fallbacks: "default"`), so a rare false-positive safety decline is retried on another model automatically.

### Reading engines

Settings → *Read photos with*:

| Engine | Cost | Good at | Weak at |
| --- | --- | --- | --- |
| **Claude** (default) | API usage | Phone photos, lyrics, chord symbols, piano-vocal layouts, D.C./coda marks | Can occasionally mis-hear a rhythm or ledger line (the app repairs rhythms and lists what it was unsure of) |
| **OpenRouter / DeepInfra / any OpenAI-compatible API** | That service's prices | Lets you use other vision models or credits you already have | Most open models are much less accurate at reading music |
| **Audiveris** (open-source, algorithmic) | Free | Clean, flat scans and PDFs (e.g. from IMSLP) | Phone photos with perspective, curl or shadows; lyrics and chord symbols |

**Free algorithmic scanning with Audiveris.** [Audiveris](https://github.com/Audiveris/audiveris) is the leading open-source optical music recognition program. It finds staff lines, noteheads, stems and beams with classic image processing plus small neural classifiers. It runs on the computer that serves the app, not in the browser and not on GitHub Pages:

1. Install Audiveris from its [releases page](https://github.com/Audiveris/audiveris/releases).
2. Start the app with the path to its launcher, for example `AUDIVERIS_CMD=/opt/audiveris/bin/Audiveris npm start`. The exact path depends on your OS and installer.
3. In Settings, choose *Audiveris*. Each page runs `Audiveris -batch -export`, and the MusicXML it produces is imported like any other file.

> Note: the Audiveris and OpenRouter/DeepInfra paths could not be tested end-to-end while building this (no Audiveris install or API keys available), unlike the Claude path's parsing, which is covered by tests.

### Command line

```bash
ANTHROPIC_API_KEY=sk-ant-... npm run transcribe -- page1.jpg page2.jpg --out song.smp.json
```

Then use **Import** in the library to open `song.smp.json`.

### Deploy to GitHub Pages

The workflow in `.github/workflows/pages.yml` builds and publishes the app on every push to `main`. Turn it on once under **Settings → Pages → Source: GitHub Actions**. On Pages there is no server, so each user adds their own key in Settings.

## Tips for good scans

- Shoot straight down, fill the frame with one page, and avoid shadows and curl. Use the rotate button if a photo comes in sideways.
- "Careful" accuracy is the default. Use "Very careful" for very dense pages.
- After scanning, play it through. Anything Claude was unsure about, and any measure whose rhythm had to be auto-repaired, is listed under **Score details**.

## Editing shortcuts (keyboard)

| Key | Action |
| --- | --- |
| Space | Play / pause |
| ↑ / ↓ | Note up/down a step in the key (Shift: semitone, Ctrl/⌘: octave) |
| ← / → | Previous / next note (Alt+↑/↓: staff above/below) |
| A–G | Set the note name (turns a rest into a note); Shift+letter adds to the chord |
| 1–7 | 64th … whole note; `.` toggles the dot |
| 0 / Delete | Make it a rest |
| + − n | Sharp, flat, natural |
| t s > l | Tie, staccato, accent, lyric |
| Ctrl/⌘ C / V | Copy / paste selected measures |
| Ctrl/⌘ Z / Y | Undo / redo |

On a phone, the same tools are on the edit palette.

In **Play along**, use ←/→ (or PageUp/PageDown, which is what most page-turner pedals send) to turn pages and Space to start or stop.

## How it works

```
photo ─► resize (≤2576 px, EXIF-rotated, contrast boost)
      ─► Claude (structured JSON; compact per-measure note strings such as "D4+F4+Bb4/q C5/8.~")
      ─► parser + rhythm repair + page merge ─► Score model (src/model)
            ├─► MusicXML ─► OpenSheetMusicDisplay (drawing, tap-to-select via note mapping)
            ├─► playback plan (repeats unrolled, ties merged, dynamics → velocity) ─► Tone.js
            └─► edits / transpose / MIDI & MusicXML export
```

- `src/model` – score types, pitch/key maths, rhythm fitting, editing operations, transposition, playback planning, MusicXML and MIDI writers
- `src/omr` – prompt, output schema, Claude client (works in Node and the browser), OpenAI-compatible client, page merging
- `src/importers` – MusicXML/MXL, MIDI (quantisation and hand splitting), ABC, PDF → images
- `src/model/chordDetect.ts` – template-matching chord recognition
- `src/audio` – instruments, effects and the look-ahead scheduler
- `src/ui` – React app (library, scanner, score view, palette, transport, panels)
- `server` – tiny Node server: static files, `/api/transcribe` (streams progress as NDJSON), the IMSLP search proxy and the optional Audiveris runner

`npm test` runs the model tests.

## Credits

Folk tunes come from [The Session](https://thesession.org) and public-domain scores from [IMSLP](https://imslp.org); downloads from IMSLP happen on its own site.

Piano samples: [Salamander Grand Piano](https://archive.org/details/SalamanderGrandPianoV3) by Alexander Holm, CC BY 3.0. Notation: [OpenSheetMusicDisplay](https://opensheetmusicdisplay.org) (BSD-3). Audio: [Tone.js](https://tonejs.github.io) (MIT). The demo piece is the public-domain Minuet in G (BWV Anh. 114).
