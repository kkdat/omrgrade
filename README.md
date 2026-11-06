# OMR AutoGrader — Offline Classroom Edition

A rebuilt version of [teacherdarwin.github.io/omrgrade](https://teacherdarwin.github.io/omrgrade/) that runs
with **no internet connection** and adds classroom features on top of the original sheet scanner.

Everything is plain HTML/CSS/JavaScript. No build step, no server, no account, no uploads — the
camera frames, answer keys and student results never leave the device.

---

## What is new

### Works offline
- All four libraries (Tailwind, jsPDF, Font Awesome, OpenCV) are **bundled in `vendor/`** — nothing is fetched from a CDN, so the scanner works from the very first load, even with no connection.
- `service-worker.js` + `manifest.json` make it an installable **PWA**: “Install” in the header, or “Add to Home Screen”. Tap the *Online/Offline* chip to force a full offline save.
- The header shows whether the sheet reader is ready, so a failure is visible instead of a silent hang.

### Results that actually persist
The original saved data through a `window.storage` API that exists only in its original host, so on
GitHub Pages keys and results were lost on reload. This version stores everything in `localStorage`
and adds **Backup / Restore** (a single JSON file) so a teacher can move data between devices.

### Class roster & automatic names
Paste or import `ID, Name` lines per section (CSV or text). Scanned sheets are matched to the real
name from the 7-digit Student ID. The roster panel shows **who has not been scanned yet**, and
unknown IDs are flagged instead of silently becoming “Student 1234567”.

### Duplicate protection
Scanning the same student twice **replaces** the earlier result instead of double-counting the class.

### Photo grading (no webcam needed)
Sheet photos can be uploaded and read exactly like a camera frame — useful on a laptop without a
camera, or when sheets were scanned on a phone.

### Marking-quality warnings
The scanner now reports **faint or double-filled bubbles** and unreadable IDs, and the preview
highlights them, so bad sheets are caught while the student is still in front of you.

### Real assessment analytics
The Analysis tab now gives the numbers teachers actually use:

- **Class summary** — graded count, mean, median, standard deviation, pass rate (configurable pass mark), score distribution.
- **KR-20 reliability** — internal consistency of the test.
- **Difficulty (p)** for every item, with a visual bar.
- **Discrimination** (item-rest point-biserial) — does the item separate strong from weak students?
- **Distractor analysis** — the choice breakdown per item, highlighting the wrong answer that tempted the class (a misconception signal).
- **Verdicts** — `Good item`, `Challenging`, `Too hard`, `Too easy`, `Weak item`, and `Check key` when discrimination is negative (the usual sign of a mis-keyed answer).
- **“Reteach first”** summary, plus a printable **class report** (item table + full score sheet).

### Student reports
Click any result to open a report: score, class comparison, answer map, and the exact items to
review with what the student chose versus the correct answer. Printable.

### Sheet generator
- Optional exam title printed on the sheet.
- Item count is limited to **40** — the layout has two columns of 20. (The original allowed 100, but
  anything over 40 printed bubbles off the page, so those sheets could never be scanned.)
- Sheet geometry and detection thresholds are unchanged, so **sheets printed with the old version
  still scan**.

---

## Hosting it

### GitHub Pages (replacing the current site)
1. Keep your repository.
2. Replace `index.html` with the one in this folder.
3. Add the rest of the files at the repository root: `app.js`, `omr.js`, `styles.css`,
   `service-worker.js`, `manifest.json`, `icon-192.png`, `icon-512.png` and the `vendor/`
   folder (including `vendor/opencv.js`, ~9 MB).
4. Commit and push. Pages serves `https://<user>.github.io/omrgrade/`.

Because the app is a PWA, visitors must open it over **https** (Pages is https) to get offline cache
and the camera.

### Anywhere else
Copy the folder to any static host, or run it locally:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

The camera requires `localhost` or `https` in most browsers. Opening `index.html` directly from the
file system still works for the PDF generator and manual key entry, but camera, offline cache and
photo reading need a real http(s) origin.

---

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Interface |
| `styles.css` | Custom styles, charts, print layout |
| `omr.js` | Sheet geometry, PDF generator, OpenCV vision engine |
| `app.js` | State, storage, roster, grading, analysis, reports, PWA wiring |
| `service-worker.js` | Offline cache |
| `manifest.json` | Installable app metadata |
| `vendor/` | Tailwind, jsPDF, Font Awesome, OpenCV (all local) |

## Privacy

No analytics, no telemetry, no network requests at runtime. Student names, IDs and answers live in
the browser's local storage on that device until you delete them (Students → Clear section) or clear
site data. Backups are files you create yourself.

## Credits

Original concept and OMR pipeline: **teacherdarwin/omrgrade** (bubble layout, OpenCV detection
thresholds and PDF geometry are preserved). This edition adds the offline packaging, persistence,
roster, analytics, reports and quality warnings.
