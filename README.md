# ListenStats

**ListenStats** is a fully client-side Spotify history analyzer. The site runs entirely in your browser so your streaming data never leaves your machine. Upload the `my_spotify_data.zip` archive or individual `Streaming_History_Audio_*.json` files and instantly explore your listening habits.

## Features

- 📈 Top songs and artists with interactive tables
- 📊 Time-based patterns with Plotly charts
- 🔥 Listening streaks and trending tracks
- ⭐ Monthly favorites and unique artist/song counts
- 🗓️ Filter by custom date range and limit results
- 📤 Share or export results to HTML, PDF or a link
- **Wrapped all time** – see stats for your entire history, not just one year

## Getting Your Data

1. Visit your [Spotify privacy settings](https://www.spotify.com/account/privacy/) and request the **extended streaming history**.
2. After receiving the email from Spotify, download `my_spotify_data.zip`.
3. Open `index.html` (or the hosted site) and upload the file to begin analyzing.

## Development

This repository contains a static site. No build step is required—open `index.html` directly or serve the folder with any web server.

## Acknowledgments

Based on the work of [timo-eberl/spotify-history-analysis](https://github.com/timo-eberl/spotify-history-analysis) with a browser-first approach.
