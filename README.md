# Sheet Music Player

Take a photo of sheet music (one page or several), and get a real, editable score you can play back.

- **Scan**: photograph pages with your phone (or pick photos). Claude reads every note, rest, tie, chord symbol, lyric, repeat and D.C./coda mark, and multi-page pieces are stitched together (pages with printed numbers are sorted automatically).
- **See it**: the music is engraved properly (OpenSheetMusicDisplay), with lyrics, chord symbols, dynamics, articulations, crescendo and diminuendo hairpins, 8va/8vb lines, tremolo slashes, triplet brackets and a subtitle line under the title.
- **Hear it**: a sampled grand piano (Salamander) with reverb, dynamics, crescendos and diminuendos, tremolos, accents, staccato, slurs and a light human feel. Eighth notes are swung from a measure whose text says "Swing" until one that says "Straight". Other parts can use voice, flute, strings, organ, music box, marimba, guitar or bass sounds. Repeats, 1st/2nd endings, D.C./D.S. al Fine/Coda are followed. Notes light up as they play and the page follows along.
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
| **This device** (default; [homr](https://github.com/liebharc/homr) in the browser) | Free, no key, nothing uploaded | Notes and rhythms from phone photos; works on GitHub Pages | No title, lyrics or chord symbols; 1–3 minutes a page; a one-time download of about 200 MB; needs a phone or computer with enough free memory |
| **Claude** | API usage | Phone photos, lyrics, chord symbols, piano-vocal layouts, D.C./coda marks | Can occasionally mis-hear a rhythm or ledger line (the app repairs rhythms and lists what it was unsure of) |
| **OpenRouter / DeepInfra / any OpenAI-compatible API** | That service's prices | Lets you use other vision models or credits you already have | Most open models are much less accurate at reading music |
| **Audiveris** (open-source, algorithmic) | Free | Clean, flat scans and PDFs (e.g. from IMSLP) | Phone photos with perspective, curl or shadows; lyrics and chord symbols |

**Scanning on the device with homr.** `npm run fetch-homr` downloads homr's three ONNX models, its Python package and the ONNX Runtime WebAssembly files into `public/homr/` (about 160 MB, not committed; the Pages workflow runs it before building). In the browser, homr's Python image processing runs in [Pyodide](https://pyodide.org) (loaded from jsDelivr) and its networks in [ONNX Runtime Web](https://onnxruntime.ai); see `src/omr/local`. Without those files the option reports that it is not included. homr is licensed AGPL-3.0, so a copy of this app that ships it must offer its source under AGPL-compatible terms.

**Title, chords and lyrics for on-device scans.** homr reads only notes and rhythms. With *Add the title, tempo, chord symbols and lyrics with an AI model* ticked in Settings and an OpenRouter (or DeepInfra, or other OpenAI-compatible) key entered, each photo is also sent to that model together with the melody homr found, and the model's answer is written into the score (`src/omr/annotate.ts`). On OpenRouter the model defaults to `anthropic/claude-opus-5.5`. Without a key this step is skipped.

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

The workflow in `.github/workflows/pages.yml` builds and publishes the app on every push to `main`. Turn it on once under **Settings → Pages → Source: GitHub Actions**. On Pages there is no server: scanning on the device works without a key, and for the Claude or OpenRouter/DeepInfra readers each user adds their own key in Settings.

## Tips for good scans

- Shoot straight down, fill the frame with one page, and avoid shadows and curl. Use the rotate button if a photo comes in sideways.
- "Careful" accuracy is the default. Use "Very careful" for very dense pages.
- After scanning, play it through. Anything Claude was unsure about, and any measure whose rhythm had to be auto-repaired, is listed under **Score details**.

## Asking for a change in words

The ✦ button opens a bar where you type what should change: “in measure 25, change the first C in the treble to C sharp”, “remove the tie from just the G and keep the C and E”, “make these two measures an octave lower in the left hand”, “transpose it up a whole step”.

- **Pointing is optional.** While the bar is open, tap notes (or one note inside a chord) and empty parts of measures to highlight them. Highlights show as chips above the text box and are sent along as “the user means this”.
- **What is sent:** the notes of the score as text, your request and the highlights go to the AI service set in Settings (the same OpenRouter key as for lyrics and chords). No photo is sent.
- **What comes back** is checked before it is used: measures that cannot be read or do not add up are left alone or padded, and the bar says so. Changed measures flash green, and **Undo** in the bar takes the whole request back.
- **Chord symbols…** in the menu has **Write chords with AI**, which hands the notes to the same service (it does not see the built-in detector's guesses).

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
