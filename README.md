# Dutch Tutor

A2 → conversational Dutch for English speakers, aimed at hanging out with friends, football and the bar.

## Run

Open `index.html` in a browser. No install, no server, no account. Progress is saved in that browser's local storage.

## What's in it

Eight units, each with four steps:

| Step | What you do |
| --- | --- |
| Vocabulary (30 words) | High-frequency spoken words, each with an example sentence |
| Phrases (20) | Ready-made chunks you can say as-is |
| Grammar | One short lesson plus 10 exercises (multiple choice, fill the gap, unscramble) |
| Conversation | A chat with a Dutch friend; pick the natural reply and the tutor explains why |

Units: small talk · making plans · at the bar · football · telling stories · opinions and particles · a night out · banter and slang.

Study modes for every deck: **Flashcards**, **Learn** (multiple choice), **Write** (type the Dutch), **Match** (timed pairs) and, for phrases, **Build** (unscramble the sentence).

**Review** uses spaced repetition: a card you get right comes back after 1, 3, 7, 14 and then 30 days; a miss sends it back to the start.

The ▶ buttons read Dutch aloud using the browser's speech engine. Quality depends on the Dutch voice your browser or OS provides.

## Profiles and syncing

Profiles are owned by the host project (`~/tools/twentysixseven`), not by this app, and there is no switcher here. When served by the host, the app asks `GET /api/me` who is signed in, shows that profile as a badge in the header, and stores progress (cards, streak, lessons, My words) on the host with `GET`/`PUT /api/progress/dutch-tutor`, so it follows the profile to any device that signs in. If nobody is signed in it redirects to the host's login page.

- **Where it lives:** the host keeps one JSON document per profile in its `progress.db` SQLite file (gitignored; override the path with `PROGRESS_DB`). The browser's local storage (`dutchTutor.v1.<profile>`) is an offline cache.
- **Size:** the translation history keeps only the newest 50 lookups. A new one pushes out the oldest, together with that word's study progress.
- **Badge dot:** green = synced, pulsing orange = saving, red = offline (changes are kept on the device and sent when the connection returns).
- **Several devices at once:** nothing is overwritten. When two copies meet they are merged: per card the most recently answered wins, completed lessons and My words are combined, the best streak and fastest times are kept, and a deleted lookup stays deleted. "Reset progress" is the exception: it wipes the profile on every device.
- **Per-device settings** (translator open/closed, direction) are not synced.
- **Opened without the host** (`file://` or any plain server) it uses a single `local` profile with no sync.

Progress saved before profiles existed is handed once to the first profile that opens the app.

## Translator and My words

The **Translate** button opens a sidebar that translates English ↔ Dutch. Every lookup is saved to the **My words** tab, which works like any other deck (flashcards, learn, write, match) and feeds the daily review.

Translation needs an internet connection. It uses Google Translate's public endpoint, which is unofficial and needs no key, and falls back to the MyMemory API if that fails. The text you type is sent to those services.

## Editing content

All course content lives in `js/data.js`; the formats are described at the top of that file.
