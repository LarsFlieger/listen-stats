/*
 * Client‑side Spotify History Analyzer.
 *
 * This script reads one or more Spotify streaming history JSON
 * files exported via the privacy portal, performs various analyses
 * similar to the Python implementation, and renders tables and
 * Plotly charts directly in the browser.  All computations are
 * performed locally; no data is transmitted to any server.
 */

// Toggle visibility of advanced settings
const toggleBtn = document.getElementById('toggleSettings');
const advancedOptions = document.getElementById('advancedOptions');
toggleBtn.addEventListener('click', () => {
  advancedOptions.classList.toggle('collapsed');
  if (advancedOptions.classList.contains('collapsed')) {
    toggleBtn.textContent = 'Show advanced options ▾';
  } else {
    toggleBtn.textContent = 'Hide advanced options ▴';
  }
});

// Global state for loaded history and options.  These variables are
// reused when the user toggles the list length so we don't need to
// re‑parse files each time.
let globalHistory = [];
let globalTopN = 10;
let globalStreakGap = 30;
let globalStartDateStr = '';
let globalEndDateStr = '';

// Results from the most recent analysis.  Stored globally so that
// rendering can be repeated (e.g. when toggling the number of top
// items) without recomputing.  Populated after the worker
// completes.
let globalResults = null;

// Share URL generated for the last analysis.  Populated when the user
// opens the share dialog so subsequent actions can reuse it.
let globalShareUrl = '';

// Reference to the web worker responsible for heavy computations.  It
// is lazily spawned when needed.
let worker = null;

// On initial load, check if a share hash is present and load
// precomputed results from it.  This allows sharing of analysis
// without requiring the user to re‑upload their files.  The hash
// takes the form "#data=<base64compressed>".  When present, the
// results are decompressed using pako and passed directly to
// renderResultsUI.  Advanced options are reset to defaults (top
// 10 items, 30‑minute streak gap) in this case.
window.addEventListener('DOMContentLoaded', () => {
  const hash = window.location.hash;
  if (hash && hash.startsWith('#data=')) {
    try {
      const encoded = decodeURIComponent(hash.substring(6));
      // Base64 decode
      const binary = atob(encoded);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      // Decompress using pako
      const jsonStr = pako.inflate(bytes, { to: 'string' });
      const sharedResults = JSON.parse(jsonStr);
      globalResults = sharedResults;
      console.log({ sharedResults });
      // Hide upload form and show results
      document.getElementById('uploadForm').style.display = 'none';
      document.getElementById('results').style.display = 'block';
      // Use the selected number of items stored in the shared data if available
      globalTopN = sharedResults.selectedTopN || 10;
      globalStreakGap = 30;
      renderResultsUI(sharedResults, globalTopN, globalStreakGap, '', '');
    } catch (err) {
      console.error('Failed to load shared results from hash:', err);
      // If parsing fails, clear the hash
      window.location.hash = '';
    }
  }

  // Force default configuration for the number of top items.  Even if
  // the HTML input declares a different default, set it here so that
  // users see 100 items by default and cannot exceed 100.  We also
  // restrict the maximum value to 100 to avoid large lists.
  const topInput = document.getElementById('top_n');
  if (topInput) {
    topInput.value = '100';
    topInput.max = '100';
  }

  // Share modal button bindings
  const closeBtn = document.getElementById('shareClose');
  if (closeBtn) closeBtn.onclick = closeShareModal;
  const copyBtn = document.getElementById('copyShareUrlBtn');
  if (copyBtn) copyBtn.onclick = copyShareUrl;
  const htmlBtn = document.getElementById('downloadHtmlBtn');
  if (htmlBtn) htmlBtn.onclick = downloadResultsHtml;
  const pdfBtn = document.getElementById('downloadPdfBtn');
  if (pdfBtn) pdfBtn.onclick = downloadResultsPdf;
});

/**
 * Spawn a new worker if one does not already exist.  Returns the
 * existing worker otherwise.  Workers allow computationally heavy
 * analysis to occur off the main thread so the UI remains
 * responsive.
 */
// We previously used a Web Worker to perform heavy analysis off the
// main thread.  However, loading separate worker files via the
// file:// protocol may trigger security errors in some browsers.
// Instead, analysis is now performed in this function using
// asynchronous loops that periodically yield to keep the UI responsive.
// The `worker` variable remains unused but retained for backward
// compatibility.
function getWorker() {
  return null;
}

/**
 * Analyse the history data in a background worker.  Displays
 * incremental progress updates via the loading indicator.
 *
 * @param {Array} history Filtered history entries
 * @param {number} topN Maximum number of top items to compute (up to 250)
 * @param {number} streakGap Maximum gap (minutes) allowed in a streak
 * @returns {Promise<Object>} Resolves with the computed results
 */
async function analyzeData(history, topN, streakGap) {
  // Normalize parameters
  const maxTop = Math.min(Math.max(parseInt(topN || 10), 1), 250);
  const maxGap = parseInt(streakGap || 30);
  const totalEntries = history.length;
  // Helper: yield control to UI thread
  const yieldToUI = async () => new Promise((r) => setTimeout(r, 0));
  // Report progress
  const report = (fraction, msg) => updateProgress(fraction, msg);
  report(0.0, 'Starting analysis');
  // Basic aggregations
  let totalMs = 0;
  const artistPlaytime = new Map();
  const artistSet = new Set();
  const songPlaytime = new Map();
  const songPlaycount = new Map();
  const artistPlaycountMap = new Map();
  const songUriMap = new Map();
  const incognitoCountMap = new Map();
  const skipCountMap = new Map();
  const platformCounts = new Map();
  const countryCounts = new Map();
  const startReasonCounts = new Map();
  const endReasonCounts = new Map();
  const shuffleCounts = new Map();
  const offlineCounts = new Map();
  const dailyMs = new Map();
  const weekdayMs = new Map();
  let playsCount = 0;
  let skipsCount = 0;
  let regularCount = 0;
  let incognitoCount = 0;
  let latestDate = null;
  // Helper
  function incMap(map, key, inc = 1) {
    map.set(key, (map.get(key) || 0) + inc);
  }
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  for (let i = 0; i < totalEntries; i++) {
    const entry = history[i];
    const ms = entry.ms_played || 0;
    totalMs += ms;
    const track = entry.master_metadata_track_name;
    const artist = entry.master_metadata_album_artist_name;
    if (artist) artistSet.add(artist);
    if (track && artist) {
      const songKey = `${track} by ${artist}`;
      if (ms > 0) {
        songPlaytime.set(songKey, (songPlaytime.get(songKey) || 0) + ms);
      }
      if (!entry.skipped) {
        songPlaycount.set(songKey, (songPlaycount.get(songKey) || 0) + 1);
        // Increment artist play count
        artistPlaycountMap.set(artist, (artistPlaycountMap.get(artist) || 0) + 1);
      }
      // Store the first encountered URI for this song
      if (entry.spotify_track_uri && !songUriMap.has(songKey)) {
        songUriMap.set(songKey, entry.spotify_track_uri);
      }
    }
    if (entry.incognito_mode) {
      const key = track && artist ? `${track} by ${artist}` : 'Unknown';
      incognitoCountMap.set(key, (incognitoCountMap.get(key) || 0) + 1);
    }
    if (entry.skipped) {
      if (track && artist) {
        const key = `${track} by ${artist}`;
        skipCountMap.set(key, (skipCountMap.get(key) || 0) + 1);
      }
      skipsCount++;
    } else {
      playsCount++;
    }
    if (artist && ms > 0) {
      artistPlaytime.set(artist, (artistPlaytime.get(artist) || 0) + ms);
    }
    const platform = entry.platform || 'Unknown';
    incMap(platformCounts, platform);
    const country = entry.conn_country || 'Unknown';
    incMap(countryCounts, country);
    const rstart = entry.reason_start || 'Unknown';
    incMap(startReasonCounts, rstart);
    const rend = entry.reason_end || 'Unknown';
    incMap(endReasonCounts, rend);
    const shuffleVal = entry.shuffle === true ? 'On' : (entry.shuffle === false ? 'Off' : 'Unknown');
    incMap(shuffleCounts, shuffleVal);
    const offlineVal = entry.offline === true ? 'Offline' : (entry.offline === false ? 'Online' : 'Unknown');
    incMap(offlineCounts, offlineVal);
    if (entry.incognito_mode) incognitoCount++; else regularCount++;
    if (ms > 0 && entry.ts) {
      const dt = new Date(entry.ts);
      if (!isNaN(dt)) {
        if (!latestDate || dt > latestDate) latestDate = dt;
        const dateKey = dt.toISOString().substring(0, 10);
        dailyMs.set(dateKey, (dailyMs.get(dateKey) || 0) + ms);
        const wd = dayNames[dt.getDay()];
        weekdayMs.set(wd, (weekdayMs.get(wd) || 0) + ms);
      }
    }
    if (i % 5000 === 0) {
      report(i / totalEntries * 0.1, 'Processing entries');
      await yieldToUI();
    }
  }
  report(0.12, 'Aggregated entries');
  // Unique counts
  const uniqueSongsCount = songPlaytime.size;
  const uniqueArtistsCount = artistSet.size;
  // Top lists
  const topPlaytimeArr = Array.from(songPlaytime.entries()).sort((a, b) => b[1] - a[1]);
  const topPlaytime = topPlaytimeArr.map(([song, ms]) => [song, ms / 60000]);
  const topPlaycountArr = Array.from(songPlaycount.entries()).sort((a, b) => b[1] - a[1]);
  const topPlaycount = topPlaycountArr;
  const incognitoTopArr = Array.from(incognitoCountMap.entries()).sort((a, b) => b[1] - a[1]);
  const skippedTopArr = Array.from(skipCountMap.entries()).sort((a, b) => b[1] - a[1]);
  const topArtistsArr = Array.from(artistPlaytime.entries()).sort((a, b) => b[1] - a[1]);
  const topArtists = topArtistsArr.map(([artist, ms]) => [artist, ms / 60000]);

  // Top artists by play count (non-skipped plays)
  const topArtistsByCountArr = Array.from(artistPlaycountMap.entries()).sort((a, b) => b[1] - a[1]);
  report(0.18, 'Computed top lists');
  // Streaks
  const intervals = [];
  for (const entry of history) {
    const ms = entry.ms_played || 0;
    if (ms <= 0) continue;
    const ts = entry.ts;
    if (!ts) continue;
    const start = new Date(ts);
    if (isNaN(start)) continue;
    const end = new Date(start.getTime() + ms);
    intervals.push([start, end]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  const maxGapMs = maxGap * 60 * 1000;
  const streaksList = [];
  let currentStart = null;
  let currentEnd = null;
  for (const [start, end] of intervals) {
    if (!currentEnd) {
      currentStart = start;
      currentEnd = end;
    } else {
      const gap = start - currentEnd;
      if (gap <= maxGapMs) {
        if (end > currentEnd) currentEnd = end;
      } else {
        streaksList.push([currentStart, currentEnd]);
        currentStart = start;
        currentEnd = end;
      }
    }
  }
  if (currentStart && currentEnd) streaksList.push([currentStart, currentEnd]);
  streaksList.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]));
  const topStreaks = streaksList.map((streak, idx) => {
    const dur = streak[1] - streak[0];
    const hours = Math.floor(dur / (3600 * 1000));
    const minutes = Math.floor((dur % (3600 * 1000)) / (60 * 1000));
    return { rank: idx + 1, duration: `${hours}h ${minutes}m`, start: formatDateTime(streak[0]), end: formatDateTime(streak[1]) };
  });
  // Streak counts for thresholds 1..10
  const streakDurations = streaksList.map(([s, e]) => e - s);
  const streakCounts = [];
  for (let h = 1; h <= Math.min(10, maxTop); h++) {
    const thresholdMs = h * 3600 * 1000;
    let count = 0;
    for (const d of streakDurations) if (d >= thresholdMs) count++;
    streakCounts.push({ threshold: `${h}h:00`, count });
  }
  report(0.25, 'Computed streaks');
  // By hour
  const byHour = {};
  for (const entry of history) {
    const ms = entry.ms_played || 0;
    if (ms <= 0 || !entry.ts) continue;
    const dt = new Date(entry.ts);
    if (isNaN(dt)) continue;
    const hr = dt.getHours();
    byHour[hr] = (byHour[hr] || 0) + ms / 60000;
  }
  for (let h = 0; h < 24; h++) if (!(h in byHour)) byHour[h] = 0;
  // Average per month across years
  const yearMonthPlaytime = new Map();
  for (const entry of history) {
    const ms = entry.ms_played || 0;
    if (ms <= 0 || !entry.ts) continue;
    const dt = new Date(entry.ts);
    if (isNaN(dt)) continue;
    const year = dt.getFullYear();
    const month = dt.getMonth() + 1;
    if (!yearMonthPlaytime.has(year)) yearMonthPlaytime.set(year, new Map());
    const mMap = yearMonthPlaytime.get(year);
    mMap.set(month, (mMap.get(month) || 0) + ms);
  }
  const monthTotals = new Map();
  for (const [year, mMap] of yearMonthPlaytime.entries()) {
    for (let m = 1; m <= 12; m++) {
      const ms = mMap.get(m);
      if (ms) {
        if (!monthTotals.has(m)) monthTotals.set(m, []);
        monthTotals.get(m).push(ms);
      }
    }
  }
  const avgByMonth = {};
  for (let m = 1; m <= 12; m++) {
    const plays = monthTotals.get(m) || [];
    if (plays.length > 0) {
      const avg = plays.reduce((a, b) => a + b, 0) / plays.length;
      avgByMonth[m] = avg;
    } else {
      avgByMonth[m] = 0;
    }
  }
  // Monthly favorites and uniques counts
  const monthlySongPlaytime = new Map();
  const uniquesMonth = {};
  for (const entry of history) {
    const ms = entry.ms_played || 0;
    if (ms <= 0) continue;
    const track = entry.master_metadata_track_name;
    const artist = entry.master_metadata_album_artist_name;
    if (!track || !artist) continue;
    const dt = new Date(entry.ts);
    if (isNaN(dt)) continue;
    const monthKey = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
    if (!monthlySongPlaytime.has(monthKey)) monthlySongPlaytime.set(monthKey, new Map());
    const mMap = monthlySongPlaytime.get(monthKey);
    const songKey = `${track} by ${artist}`;
    mMap.set(songKey, (mMap.get(songKey) || 0) + ms);
    if (!uniquesMonth[monthKey]) uniquesMonth[monthKey] = { artists: new Set(), songs: new Set() };
    uniquesMonth[monthKey].artists.add(artist);
    uniquesMonth[monthKey].songs.add(track);
  }
  const favorites = {};
  const sortedMonths = Array.from(monthlySongPlaytime.keys()).sort();
  sortedMonths.forEach(month => {
    const mMap = monthlySongPlaytime.get(month);
    let favSong = null;
    let maxMs = 0;
    for (const [song, ms] of mMap.entries()) {
      if (ms > maxMs) { maxMs = ms; favSong = song; }
    }
    favorites[month] = [favSong, maxMs / 60000];
  });
  const uniquesMonthCounts = {};
  for (const month in uniquesMonth) {
    uniquesMonthCounts[month] = {
      artists: uniquesMonth[month].artists.size,
      songs: uniquesMonth[month].songs.size
    };
  }
  report(0.35, 'Computed monthly stats');
  // Top plays per day and per week
  const playsBySongDay = new Map();
  const playsBySongWeek = new Map();
  for (const entry of history) {
    const track = entry.master_metadata_track_name;
    const artist = entry.master_metadata_album_artist_name;
    if (!track || !artist || entry.skipped) continue;
    const songKey = `${track} by ${artist}`;
    const dt = new Date(entry.ts);
    if (isNaN(dt)) continue;
    const date = dt.toISOString().substring(0, 10);
    const dayKey = `${songKey}|||${date}`;
    playsBySongDay.set(dayKey, (playsBySongDay.get(dayKey) || 0) + 1);
    const weekNum = getISOWeekNumber(dt);
    const weekYear = getISOWeekYear(dt);
    const weekKey = `${songKey}|||${weekYear}|||${weekNum}`;
    playsBySongWeek.set(weekKey, (playsBySongWeek.get(weekKey) || 0) + 1);
  }
  const topDayArr = Array.from(playsBySongDay.entries()).sort((a, b) => b[1] - a[1]);
  const topWeekArr = Array.from(playsBySongWeek.entries()).sort((a, b) => b[1] - a[1]);
  report(0.4, 'Computed top plays per day/week');
  // Co-listening for top songs (limit 50 base songs)
  const coListens = {};
  try {
    const baseSongs = new Set(topPlaytime.slice(0, Math.min(50, maxTop)).map(item => item[0]));
    const sortedHistory = history
      .filter(e => {
        const track = e.master_metadata_track_name;
        const artist = e.master_metadata_album_artist_name;
        return track && artist && !e.skipped;
      })
      .map(e => {
        const dt = new Date(e.ts);
        return { ts: dt, song: `${e.master_metadata_track_name} by ${e.master_metadata_album_artist_name}` };
      })
      .filter(e => !isNaN(e.ts))
      .sort((a, b) => a.ts - b.ts);
    const n = sortedHistory.length;
    for (let i = 0; i < n; i++) {
      const baseSong = sortedHistory[i].song;
      if (!baseSongs.has(baseSong)) continue;
      const windowStart = sortedHistory[i].ts;
      const windowEnd = new Date(windowStart.getTime() + 30 * 60 * 1000);
      const uniqueSongs = new Set();
      for (let j = i; j < n && sortedHistory[j].ts <= windowEnd; j++) {
        uniqueSongs.add(sortedHistory[j].song);
      }
      uniqueSongs.forEach(song2 => {
        if (song2 === baseSong) return;
        if (!coListens[baseSong]) coListens[baseSong] = {};
        coListens[baseSong][song2] = (coListens[baseSong][song2] || 0) + 1;
      });
      if (i % 1000 === 0) {
        report(0.45 + (i / n) * 0.05, 'Computing co-listening');
        await yieldToUI();
      }
    }
    for (const song in coListens) {
      const entries = Object.entries(coListens[song]);
      entries.sort((a, b) => b[1] - a[1]);
      coListens[song] = entries;
    }
  } catch (err) {
    console.error('Co-listening failed', err);
  }
  // Daily minutes and weekday minutes
  const dailyMinutes = {};
  const sortedDaily = Array.from(dailyMs.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  sortedDaily.forEach(([date, ms]) => { dailyMinutes[date] = ms / 60000; });
  const weekdayMinutes = {};
  for (const [day, ms] of weekdayMs.entries()) weekdayMinutes[day] = ms / 60000;
  report(0.55, 'Computed daily and weekday stats');
  // Trending songs
  const trendingList = [];
  if (latestDate) {
    const oneDay = 24 * 60 * 60 * 1000;
    const startLast30 = new Date(latestDate.getTime() - 30 * oneDay);
    const startPrev30 = new Date(startLast30.getTime() - 30 * oneDay);
    const last30Counts = new Map();
    const prev30Counts = new Map();
    for (const entry of history) {
      const track = entry.master_metadata_track_name;
      const artist = entry.master_metadata_album_artist_name;
      if (!track || !artist) continue;
      const dt = new Date(entry.ts);
      if (isNaN(dt)) continue;
      const songKey = `${track} by ${artist}`;
      if (dt > startLast30) {
        last30Counts.set(songKey, (last30Counts.get(songKey) || 0) + 1);
      } else if (dt > startPrev30) {
        prev30Counts.set(songKey, (prev30Counts.get(songKey) || 0) + 1);
      }
    }
    for (const [song, cnt] of last30Counts.entries()) {
      const prev = prev30Counts.get(song) || 0;
      const delta = cnt - prev;
      if (delta > 0) trendingList.push([song, delta]);
    }
    trendingList.sort((a, b) => b[1] - a[1]);
  }
  report(0.6, 'Computed trending songs');
  // Convert maps to objects for serialization
  function mapToObj(map) { const obj = {}; for (const [k, v] of map.entries()) obj[k] = v; return obj; }
  const results = {
    totalMinutes: Math.floor(totalMs / 60000),
    uniqueArtists: uniqueArtistsCount,
    uniqueSongs: uniqueSongsCount,
    topPlaytime: topPlaytime,
    topPlaycount: topPlaycount,
    incognitoTop: incognitoTopArr,
    skippedTop: skippedTopArr,
    topArtists: topArtists,
    streaks: topStreaks,
    streakCounts: streakCounts,
    byHour: byHour,
    avgByMonth: avgByMonth,
    favorites: favorites,
    uniquesMonth: uniquesMonthCounts,
    topDay: topDayArr,
    topWeek: topWeekArr,
    coListens: coListens,
    daily: dailyMinutes,
    weekdayTime: weekdayMinutes,
    playsCount: playsCount,
    skipsCount: skipsCount,
    regularCount: regularCount,
    incognitoCount: incognitoCount,
    trending: trendingList.slice(0, 10),
    platformCounts: mapToObj(platformCounts),
    countryCounts: mapToObj(countryCounts),
    startReasonCounts: mapToObj(startReasonCounts),
    endReasonCounts: mapToObj(endReasonCounts),
    shuffleCounts: mapToObj(shuffleCounts),
    offlineCounts: mapToObj(offlineCounts),
    topArtistsByCount: topArtistsByCountArr
    ,
    songUris: mapToObj(songUriMap)
  };
  report(0.8, 'Finalizing');
  return results;
}

// References to loading UI elements
const loadingDiv = document.getElementById('loading');
const progressBar = document.getElementById('progressBar');
const loadingText = document.getElementById('loadingText');
const showMoreBtn = document.getElementById('showMoreBtn');

/**
 * Display the loading indicator and reset progress.  Optionally set
 * an initial message.
 * @param {string} msg
 */
function showLoading(msg = 'Loading…') {
  progressBar.value = 0;
  progressBar.max = 100;
  loadingText.textContent = msg;
  loadingDiv.style.display = 'block';
}

/**
 * Update the progress bar and accompanying text.  Values should be
 * between 0 and 1, representing completion percentage.
 * @param {number} fraction
 * @param {string} msg
 */
function updateProgress(fraction, msg) {
  progressBar.value = Math.floor(fraction * 100);
  loadingText.textContent = `${msg} (${Math.floor(fraction * 100)}%)`;
}

/**
 * Hide the loading indicator.
 */
function hideLoading() {
  loadingDiv.style.display = 'none';
}

/**
 * Load one or more JSON files directly.  Shows progress as each file
 * is parsed.
 * @param {File[]} files
 * @returns {Promise<Array>} list of history entries
 */
async function loadJsonFiles(files) {
  const history = [];
  let loaded = 0;
  for (const file of files) {
    const text = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    });
    try {
      const data = JSON.parse(text);
      if (Array.isArray(data)) {
        history.push(...data);
      }
    } catch (err) {
      console.warn('Failed to parse file:', file.name, err);
    }
    loaded++;
    updateProgress(loaded / files.length, `Reading ${file.name}`);
    // yield to UI
    await new Promise(res => setTimeout(res, 0));
  }
  return history;
}

/**
 * Load a ZIP archive containing one or more JSON files.  Only files
 * ending in .json inside the archive are considered.  Progress is
 * updated as each JSON file is processed.
 * @param {File} file The uploaded ZIP archive
 * @returns {Promise<Array>} list of history entries
 */
async function loadZipFile(file) {
  const zip = await JSZip.loadAsync(file);
  // Collect all JSON files within the archive.  Many Spotify exports
  // nest files under a folder like "Spotify Extended Streaming History".
  const jsonFiles = [];
  Object.keys(zip.files).forEach((relPath) => {
    const zipEntry = zip.files[relPath];
    if (!zipEntry.dir && /\.json$/i.test(relPath)) {
      jsonFiles.push(zipEntry);
    }
  });
  if (jsonFiles.length === 0) {
    return [];
  }
  const history = [];
  let processed = 0;
  for (const entry of jsonFiles) {
    const content = await entry.async('string');
    try {
      const data = JSON.parse(content);
      if (Array.isArray(data)) {
        history.push(...data);
      }
    } catch (err) {
      console.warn('Failed to parse JSON in', entry.name, err);
    }
    processed++;
    updateProgress(processed / jsonFiles.length, `Extracting ${entry.name}`);
    await new Promise(res => setTimeout(res, 0));
  }
  return history;
}

// Handle the form submission
document.getElementById('uploadForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const fileInput = document.getElementById('files');
  const files = Array.from(fileInput.files || []);
  if (files.length === 0) {
    alert('Please select at least one history file.');
    return;
  }
  // Show loading UI
  showLoading('Reading files…');
  let history = [];
  try {
    // If a single ZIP archive is uploaded, extract it; otherwise parse JSON files directly
    if (files.length === 1 && /\.zip$/i.test(files[0].name)) {
      history = await loadZipFile(files[0]);
    } else {
      history = await loadJsonFiles(files);
    }
  } catch (err) {
    console.error('Error loading files', err);
  }
  hideLoading();
  if (!history || history.length === 0) {
    alert('No valid history entries found in uploaded files.');
    return;
  }
  // Extract advanced options
  globalStartDateStr = document.getElementById('start_date').value;
  globalEndDateStr = document.getElementById('end_date').value;
  globalTopN = parseInt(document.getElementById('top_n').value) || 10;
  globalStreakGap = parseInt(document.getElementById('streak_gap').value) || 30;
  // Store history globally
  globalHistory = history;
  // Filter history by date range if provided
  let filteredHistory = history;
  let startDate = null;
  if (globalStartDateStr) startDate = new Date(globalStartDateStr);
  let endDate = null;
  if (globalEndDateStr) {
    endDate = new Date(globalEndDateStr);
    endDate.setHours(23, 59, 59, 999);
  }
  if (startDate || endDate) {
    filteredHistory = history.filter(entry => {
      const tsStr = entry.ts;
      if (!tsStr) return false;
      const date = new Date(tsStr);
      if (isNaN(date)) return false;
      if (startDate && date < startDate) return false;
      if (endDate && date > endDate) return false;
      return true;
    });
  }
  // Analyse data in a background thread to avoid blocking the UI.  Use
  // a separate loading state for calculation.
  showLoading('Analyzing data…');
  try {
    const results = await analyzeData(filteredHistory, globalTopN, globalStreakGap);
    globalResults = results;
    hideLoading();
    renderResultsUI(results, globalTopN, globalStreakGap, globalStartDateStr, globalEndDateStr);
  } catch (err) {
    console.error('Analysis failed', err);
    hideLoading();
    alert('An error occurred during analysis. Please try again.');
  }
});

/**
 * Compute and render all statistics given the history entries.
 *
 * @param {Array} history Array of history objects
 * @param {number} topN How many top items to display
 * @param {number} streakGap Maximum gap in minutes allowed between plays in a streak
 * @param {string} startDateStr Start date as YYYY-MM-DD or empty
 * @param {string} endDateStr End date as YYYY-MM-DD or empty
 */
function renderResultsUI(results, topN, streakGap, startDateStr, endDateStr) {
  // Use pre‑computed results from the worker.  Slice arrays to the
  // requested topN where appropriate.
  const totalMinutes = results.totalMinutes;
  const uniqueArtistsCount = results.uniqueArtists;
  const uniqueSongsCount = results.uniqueSongs;
  const topPlaytime = results.topPlaytime.slice(0, topN);
  const topPlaycount = results.topPlaycount.slice(0, topN);
  const incognitoTop = results.incognitoTop.slice(0, topN);
  const skippedTop = results.skippedTop.slice(0, topN);
  const topArtists = results.topArtists.slice(0, topN);
  const streaks = results.streaks.slice(0, topN);
  const streakCounts = results.streakCounts.slice(0, topN);
  const byHour = results.byHour;
  const avgByMonth = results.avgByMonth;
  const favorites = results.favorites;
  const uniquesMonth = results.uniquesMonth;
  const topDay = results.topDay.slice(0, topN);
  const topWeek = results.topWeek.slice(0, topN);
  const coListens = results.coListens;
  const daily = results.daily;
  const weekdayTime = results.weekdayTime;
  const playsCount = results.playsCount;
  const skipsCount = results.skipsCount;
  const regularCount = results.regularCount;
  const incognitoCount = results.incognitoCount;
  const trending = results.trending; // always top 10 from worker
  // Additional aggregated stats
  const platformCounts = results.platformCounts;
  const countryCounts = results.countryCounts;
  const startReasonCounts = results.startReasonCounts;
  const endReasonCounts = results.endReasonCounts;
  const shuffleCountObj = results.shuffleCounts;
  const offlineCountObj = results.offlineCounts;
  // Show results container
  document.getElementById('results').style.display = 'block';
  // Fill summary
  const summaryDiv = document.getElementById('summary');
  summaryDiv.innerHTML = '';
  summaryDiv.appendChild(createCard(totalMinutes.toLocaleString(), 'Total minutes'));
  summaryDiv.appendChild(createCard(Math.floor(totalMinutes / 60).toLocaleString(), 'Total hours'));
  summaryDiv.appendChild(createCard(uniqueArtistsCount.toLocaleString(), 'Unique artists'));
  summaryDiv.appendChild(createCard(uniqueSongsCount.toLocaleString(), 'Unique songs'));
  // Fill top songs & artists
  const topContainer = document.getElementById('top-songs');
  topContainer.innerHTML = '';
  // Helper to convert song names into clickable links when a URI is available
  const songUriMap = results.songUris || {};
  function makeSongLink(song) {
    const uri = songUriMap[song];
    if (uri) {
      const id = uri.split(':').pop();
      const href = `https://open.spotify.com/track/${id}`;
      return { html: `<a href="${href}" target="_blank">${song}</a>` };
    }
    return song;
  }
  topContainer.appendChild(createTopTable('Top Songs by Playtime', ['#', 'Song', 'Duration'], topPlaytime.map(([song, mins], idx) => [idx + 1, makeSongLink(song), formatMinutes(mins)])));
  topContainer.appendChild(createTopTable('Top Songs by Play Count', ['#', 'Song', 'Plays'], topPlaycount.map(([song, count], idx) => [idx + 1, makeSongLink(song), count])));
  topContainer.appendChild(createTopTable('Most Played in Incognito Mode', ['#', 'Song', 'Plays'], incognitoTop.map(([song, count], idx) => [idx + 1, makeSongLink(song), count])));
  topContainer.appendChild(createTopTable('Most Skipped Songs', ['#', 'Song', 'Skips'], skippedTop.map(([song, count], idx) => [idx + 1, makeSongLink(song), count])));
  topContainer.appendChild(createTopTable('Top Artists by Playtime', ['#', 'Artist', 'Duration'], topArtists.map(([artist, mins], idx) => [idx + 1, artist, formatMinutes(mins)])));

  // Top artists by play count bar chart
  {
    const topArtistsCount = results.topArtistsByCount.slice(0, topN);
    if (topArtistsCount.length > 0) {
      const names = topArtistsCount.map(([artist]) => artist);
      const counts = topArtistsCount.map(([, count]) => count);
      const section = document.createElement('div');
      const h3 = document.createElement('h3');
      h3.textContent = 'Top Artists by Play Count';
      section.appendChild(h3);
      const p = document.createElement('p');
      p.textContent = 'Artists ranked by the number of streams (excluding skips).';
      section.appendChild(p);
      const divChart = document.createElement('div');
      const chartId = 'chart_artists_count';
      divChart.id = chartId;
      divChart.className = 'chart';
      section.appendChild(divChart);
      topContainer.appendChild(section);
      Plotly.newPlot(chartId, [{ x: names, y: counts, type: 'bar' }], { xaxis: { title: 'Artist' }, yaxis: { title: 'Play Count' }, margin: { l: 50, r: 20, t: 30, b: 90 } });
    }
  }
  // Fill streaks
  const streaksDiv = document.getElementById('streaks');
  streaksDiv.innerHTML = '';
  streaksDiv.appendChild(createTopTable(`Top ${topN} Longest Listening Streaks (max ${streakGap} min gap)`, ['#', 'Duration', 'Start', 'End'], streaks.map((s) => [s.rank, s.duration, s.start, s.end])));
  streaksDiv.appendChild(createTopTable('Streak Counts Over Duration Thresholds (10 min gap)', ['Threshold', 'Count'], streakCounts.map(s => [s.threshold, s.count])));
  // Render charts.  Charts are grouped in sections with headings and
  // descriptions to help the user understand the data.  A helper
  // function encapsulates the repeated creation of chart containers
  // and invocation of Plotly.
  const chartsDiv = document.getElementById('charts');
  chartsDiv.innerHTML = '';
  function addChart(title, description, id, data, layout) {
    const section = document.createElement('div');
    const h3 = document.createElement('h3');
    h3.textContent = title;
    section.appendChild(h3);
    if (description) {
      const p = document.createElement('p');
      p.textContent = description;
      section.appendChild(p);
    }
    const div = document.createElement('div');
    div.id = id;
    div.className = 'chart';
    section.appendChild(div);
    chartsDiv.appendChild(section);
    Plotly.newPlot(id, data, layout);
  }
  // Listening time by hour of day
  {
    const hours = Object.keys(byHour);
    const minutesArr = Object.values(byHour);
    const data = [{ x: hours, y: minutesArr, type: 'bar' }];
    const layout = { xaxis: { title: 'Hour (0‑23)' }, yaxis: { title: 'Minutes' }, margin: { l: 50, r: 20, t: 30, b: 50 } };
    addChart(
      'Listening Time by Hour',
      'Distribution of listening time across the 24 hours of the day (UTC).',
      'chart_by_hour',
      data,
      layout
    );
  }
  // Average listening time by month across years
  {
    const months = Object.keys(avgByMonth);
    const minutes = Object.values(avgByMonth).map(ms => parseFloat((ms / 60000).toFixed(2)));
    const data = [{ x: months, y: minutes, type: 'bar' }];
    const layout = { xaxis: { title: 'Month' }, yaxis: { title: 'Average Minutes' }, margin: { l: 50, r: 20, t: 30, b: 70 } };
    addChart(
      'Average Listening Time per Month',
      'Average minutes listened per month aggregated across all years.',
      'chart_avg_month',
      data,
      layout
    );
  }
  // Monthly listening time aggregated from daily data
  {
    // Aggregate daily minutes into months (YYYY-MM)
    const monthlyAgg = {};
    Object.entries(daily).forEach(([date, mins]) => {
      const month = date.slice(0, 7);
      monthlyAgg[month] = (monthlyAgg[month] || 0) + mins;
    });
    const months = Object.keys(monthlyAgg).sort();
    const minutes = months.map(m => parseFloat(monthlyAgg[m].toFixed(2)));
    const data = [{ x: months, y: minutes, type: 'bar' }];
    const layout = { xaxis: { title: 'Month' }, yaxis: { title: 'Minutes' }, margin: { l: 50, r: 20, t: 30, b: 70 } };
    addChart(
      'Monthly Listening Time',
      'Total minutes listened each month aggregated from your daily listening history.',
      'chart_monthly',
      data,
      layout
    );
  }
  // Listening time by day of week starting with Monday
  {
    const ordered = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const days = ordered.filter(d => weekdayTime[d] !== undefined);
    const minutes = days.map(d => parseFloat(weekdayTime[d].toFixed(2)));
    const data = [{ x: days, y: minutes, type: 'bar' }];
    const layout = { xaxis: { title: 'Day of Week' }, yaxis: { title: 'Minutes' }, margin: { l: 50, r: 20, t: 30, b: 50 } };
    addChart(
      'Listening Time by Day of Week',
      'Total listening time aggregated by weekday (UTC) starting on Monday.',
      'chart_weekday',
      data,
      layout
    );
  }
  // Skips vs plays
  {
    const data = [{ labels: ['Plays', 'Skips'], values: [playsCount, skipsCount], type: 'pie', hole: 0.4 }];
    const layout = { margin: { l: 20, r: 20, t: 30, b: 30 } };
    addChart(
      'Skips vs Plays',
      'Proportion of streams that were skipped versus completed.',
      'chart_plays_skips',
      data,
      layout
    );
  }
  // Incognito vs regular
  {
    const data = [{ labels: ['Regular', 'Incognito'], values: [regularCount, incognitoCount], type: 'pie', hole: 0.4 }];
    const layout = { margin: { l: 20, r: 20, t: 30, b: 30 } };
    addChart(
      'Incognito vs Regular Listening',
      'Distribution of streams played in private mode versus normal mode.',
      'chart_incognito_regular',
      data,
      layout
    );
  }
  // Plays by platform (use precomputed results.platformCounts)
  {
    const topPlatform = getTopCategories(platformCounts, 10);
    const data = [{ x: topPlatform.map(([p]) => p), y: topPlatform.map(([, c]) => c), type: 'bar' }];
    const layout = { xaxis: { title: 'Platform' }, yaxis: { title: 'Play Count' }, margin: { l: 50, r: 20, t: 30, b: 90 } };
    addChart(
      'Plays by Platform',
      'Distribution of your plays across the top platforms used.  Smaller platforms are grouped as “Other”.',
      'chart_platform',
      data,
      layout
    );
  }
  // Plays by country: present as a table rather than a bar chart
  {
    const countryRows = Object.entries(countryCounts).sort((a, b) => b[1] - a[1]).map(([c, cnt]) => [c, cnt]);
    chartsDiv.appendChild(createTopTable('Plays by Country', ['Country', 'Play Count'], countryRows));
  }
  // Reasons for starting tracks (use precomputed results.startReasonCounts)
  {
    const topReasons = getTopCategories(startReasonCounts, 10);
    const data = [{ x: topReasons.map(([r]) => r), y: topReasons.map(([, cnt]) => cnt), type: 'bar' }];
    const layout = { xaxis: { title: 'Reason Start' }, yaxis: { title: 'Count' }, margin: { l: 50, r: 20, t: 30, b: 90 } };
    addChart(
      'Reasons Tracks Were Started',
      'Why each track began playing.  Only the top reasons are shown; others are grouped as “Other”.',
      'chart_reason_start',
      data,
      layout
    );
  }
  // Reasons for ending tracks (use precomputed results.endReasonCounts)
  {
    const topReasons = getTopCategories(endReasonCounts, 10);
    const data = [{ x: topReasons.map(([r]) => r), y: topReasons.map(([, cnt]) => cnt), type: 'bar' }];
    const layout = { xaxis: { title: 'Reason End' }, yaxis: { title: 'Count' }, margin: { l: 50, r: 20, t: 30, b: 90 } };
    addChart(
      'Reasons Tracks Ended',
      'Why each track stopped playing (e.g., endplay, track skipped).  Lesser reasons are aggregated into “Other”.',
      'chart_reason_end',
      data,
      layout
    );
  }
  // Shuffle usage (use precomputed results.shuffleCounts)
  {
    const entries = Object.entries(shuffleCountObj);
    const data = [{ labels: entries.map(([k]) => k), values: entries.map(([, v]) => v), type: 'pie', hole: 0.4 }];
    const layout = { margin: { l: 20, r: 20, t: 30, b: 30 } };
    addChart(
      'Shuffle Mode Usage',
      'How often you listened with shuffle on versus off.',
      'chart_shuffle',
      data,
      layout
    );
  }
  // Offline vs online (use precomputed results.offlineCounts)
  {
    const entries = Object.entries(offlineCountObj);
    const data = [{ labels: entries.map(([k]) => k), values: entries.map(([, v]) => v), type: 'pie', hole: 0.4 }];
    const layout = { margin: { l: 20, r: 20, t: 30, b: 30 } };
    addChart(
      'Offline vs Online',
      'Proportion of your plays that occurred offline versus online or unknown.',
      'chart_offline',
      data,
      layout
    );
  }
  // Favorites per month
  const favDiv = document.getElementById('favorites');
  favDiv.innerHTML = '';
  const favRows = Object.keys(favorites).map(month => {
    const [song, mins] = favorites[month];
    return [month, song, formatMinutes(mins)];
  });
  favDiv.appendChild(createTopTable('Favorite Song per Month', ['Month', 'Song', 'Duration'], favRows));
  // Unique artists & songs per month: display as grouped bar chart
  {
    const months = Object.keys(uniquesMonth).sort();
    const artistCounts = months.map(m => uniquesMonth[m].artists);
    const songCounts = months.map(m => uniquesMonth[m].songs);
    const data = [
      { x: months, y: artistCounts, name: 'Unique Artists', type: 'bar' },
      { x: months, y: songCounts, name: 'Unique Songs', type: 'bar' }
    ];
    const layout = { barmode: 'group', xaxis: { title: 'Month' }, yaxis: { title: 'Count' }, margin: { l: 50, r: 20, t: 30, b: 90 } };
    addChart(
      'Unique Artists & Songs per Month',
      'Number of distinct artists and songs you listened to each month.',
      'chart_unique_month',
      data,
      layout
    );
  }
  // Top most plays single day/week
  const topDayWeekDiv = document.getElementById('top-day-week');
  topDayWeekDiv.innerHTML = '';
  const dayRows = topDay.map(([key, count]) => {
    const parts = String(key).split('|||');
    const song = parts[0];
    const date = parts[1];
    return [count, makeSongLink(song), date];
  });
  topDayWeekDiv.appendChild(createTopTable(`Top ${topN} Most Plays of a Single Song in One Day`, ['Plays', 'Song', 'Date'], dayRows));
  const weekRows = topWeek.map(([key, count]) => {
    const parts = String(key).split('|||');
    const song = parts[0];
    const year = parts[1];
    const week = parts[2];
    return [count, makeSongLink(song), week, year];
  });
  topDayWeekDiv.appendChild(createTopTable(`Top ${topN} Most Plays of a Single Song in One Week`, ['Plays', 'Song', 'Week', 'Year'], weekRows));
  // Co-listening
  const coDiv = document.getElementById('co-listening');
  coDiv.innerHTML = '';
  // Show co‑listening for top songs by playtime
  topPlaytime.forEach(([song]) => {
    const list = coListens[song];
    if (list && list.length > 0) {
      const section = document.createElement('div');
      const h3 = document.createElement('h3');
      h3.textContent = song;
      section.appendChild(h3);
      const ul = document.createElement('ul');
      list.slice(0, 3).forEach(([other, cnt]) => {
        const li = document.createElement('li');
        // Make other song clickable if URI available
        const linked = makeSongLink(other);
        if (typeof linked === 'object') {
          li.innerHTML = `${linked.html} (${cnt} times)`;
        } else {
          li.textContent = `${linked} (${cnt} times)`;
        }
        ul.appendChild(li);
      });
      section.appendChild(ul);
      coDiv.appendChild(section);
    }
  });
  // Trending
  const trendingDiv = document.getElementById('trending');
  trendingDiv.innerHTML = '';
  const trendRows = trending.map(([song, delta], idx) => [idx + 1, makeSongLink(song), delta]);
  trendingDiv.appendChild(createTopTable(`Trending Songs (Last 30 vs Previous 30 Days)`, ['#', 'Song', 'Increase in Plays'], trendRows));

  // Configure "show more" button to toggle between short and extended lists.  When
  // fewer than 250 items are displayed, the button offers to show the
  // expanded top 250.  Otherwise it allows returning to the default top
  // 10.  Clicking the button triggers a re‑render using the precomputed
  // global results rather than recomputing analysis.
  if (topN < 250) {
    showMoreBtn.style.display = 'inline-block';
    showMoreBtn.textContent = 'Show top 250';
    showMoreBtn.onclick = () => {
      globalTopN = 250;
      document.getElementById('top_n').value = 250;
      renderResultsUI(globalResults, 250, streakGap, startDateStr, endDateStr);
    };
  } else {
    showMoreBtn.style.display = 'inline-block';
    showMoreBtn.textContent = 'Show less';
    showMoreBtn.onclick = () => {
      globalTopN = 10;
      document.getElementById('top_n').value = 10;
      renderResultsUI(globalResults, 10, streakGap, startDateStr, endDateStr);
    };
  }
  // Scroll to results
  document.getElementById('results').scrollIntoView({ behavior: 'smooth' });

  // Display and configure the share button.  When clicked a modal is
  // shown offering multiple ways to share the current results.
  const shareBtn = document.getElementById('shareBtn');
  shareBtn.style.display = 'inline-block';
  shareBtn.textContent = 'Share';

  shareBtn.onclick = async () => {
    try {
      /**
       * Build a trimmed version of the results object for sharing.
       * Respect the current globalTopN selection so the recipient
       * sees the same number of items.  Limit to 100 items to
       * avoid excessively long URLs.  Song URIs are included
       * only for the songs in the trimmed lists.  Co‑listening
       * data is reduced to a small set of base songs and
       * co‑listens.
       */
      const shareData = (function createShareData(res, limit) {
        // Determine how many top items to include – respect the
        // user’s choice up to 100.
        const n = Math.min(limit || 10, 100);
        const trimArray = (arr) => Array.isArray(arr) ? arr.slice(0, Math.min(n, arr.length)) : arr;
        // Collect all songs we need URIs for
        const songSet = new Set();
        trimArray(res.topPlaytime).forEach(([s]) => songSet.add(s));
        trimArray(res.topPlaycount).forEach(([s]) => songSet.add(s));
        trimArray(res.incognitoTop).forEach(([s]) => songSet.add(s));
        trimArray(res.skippedTop).forEach(([s]) => songSet.add(s));
        trimArray(res.topDay).forEach(([key]) => {
          const parts = String(key).split('|||');
          if (parts[0]) songSet.add(parts[0]);
        });
        trimArray(res.topWeek).forEach(([key]) => {
          const parts = String(key).split('|||');
          if (parts[0]) songSet.add(parts[0]);
        });
        // Trending songs
        (res.trending || []).slice(0, 10).forEach(([s]) => songSet.add(s));
        // Favorite song per month
        Object.values(res.favorites || {}).forEach(([song]) => songSet.add(song));
        // Trim co‑listens – limit to 20 base songs and 5 co‑listens each
        const trimCoListens = (co) => {
          const result = {};
          const coLimit = 5;
          // Always include co-listens for songs in the trimmed topPlaytime list.
          const requiredBases = trimArray(res.topPlaytime).map(([s]) => s);
          // Additional bases can be added up to a maximum (e.g. 20) but are not strictly necessary.
          const maxBases = 20;
          const allBases = Object.keys(co);
          const extraBases = allBases.filter(b => !requiredBases.includes(b)).slice(0, Math.max(0, maxBases - requiredBases.length));
          const bases = requiredBases.concat(extraBases);
          bases.forEach(base => {
            if (!co[base]) return;
            songSet.add(base);
            const list = co[base] || [];
            result[base] = list.slice(0, coLimit);
            list.slice(0, coLimit).forEach(([s]) => songSet.add(s));
          });
          return result;
        };
        const trimmedUris = {};
        if (res.songUris) {
          Object.keys(res.songUris).forEach(song => {
            if (songSet.has(song)) trimmedUris[song] = res.songUris[song];
          });
        }
        return {
          ...res,
          totalMinutes: res.totalMinutes,
          uniqueArtists: res.uniqueArtists,
          uniqueSongs: res.uniqueSongs,
          topPlaytime: trimArray(res.topPlaytime),
          topPlaycount: trimArray(res.topPlaycount),
          incognitoTop: trimArray(res.incognitoTop),
          skippedTop: trimArray(res.skippedTop),
          topArtists: trimArray(res.topArtists),
          topArtistsByCount: trimArray(res.topArtistsByCount),
          streaks: trimArray(res.streaks),
          streakCounts: res.streakCounts,
          byHour: res.byHour,
          avgByMonth: res.avgByMonth,
          favorites: res.favorites,
          uniquesMonth: res.uniquesMonth,
          topDay: trimArray(res.topDay),
          topWeek: trimArray(res.topWeek),
          coListens: trimCoListens(res.coListens || {}),
          playsCount: res.playsCount,
          skipsCount: res.skipsCount,
          regularCount: res.regularCount,
          incognitoCount: res.incognitoCount,
          trending: (res.trending || []).slice(0, 10),
          platformCounts: res.platformCounts,
          countryCounts: res.countryCounts,
          startReasonCounts: res.startReasonCounts,
          endReasonCounts: res.endReasonCounts,
          shuffleCounts: res.shuffleCounts,
          offlineCounts: res.offlineCounts,
          songUris: trimmedUris
          ,
          // Store the selected number of top items so the share page can
          // display the same number of entries.  Limit to 100 to keep
          // the URL manageable.
          selectedTopN: n
        };
      })(globalResults, globalTopN);
      console.log({ shareData })
      const json = JSON.stringify(shareData);
      const deflated = pako.deflate(json, { to: 'string' });
      const base64 = btoa(deflated);
      const encoded = encodeURIComponent(base64);
      const url = `${window.location.origin}${window.location.pathname}#data=${encoded}`;
      console.log({ url })
      // Update hash so the link appears in the address bar
      window.location.hash = `data=${encoded}`;
      globalShareUrl = url;

      // Show modal with share options
      document.getElementById('shareModal').style.display = 'block';

    } catch (err) {
      console.error('Failed to generate share link:', err);
      alert('Unable to generate share link. Please try again.');
    }
  };
}

/** Helper to create a metric card */
function createCard(value, label) {
  const div = document.createElement('div');
  div.className = 'card';
  const h3 = document.createElement('h3');
  h3.textContent = value;
  const p = document.createElement('p');
  p.textContent = label;
  div.appendChild(h3);
  div.appendChild(p);
  return div;
}

/** Helper to create a table with a title */
function createTopTable(title, headers, rows) {
  const container = document.createElement('div');
  const h3 = document.createElement('h3');
  h3.textContent = title;
  container.appendChild(h3);
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const trHead = document.createElement('tr');
  headers.forEach(h => {
    const th = document.createElement('th');
    th.textContent = h;
    trHead.appendChild(th);
  });
  thead.appendChild(trHead);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  rows.forEach(row => {
    const tr = document.createElement('tr');
    row.forEach(cell => {
      const td = document.createElement('td');
      if (cell && typeof cell === 'object' && cell.html) {
        td.innerHTML = cell.html;
      } else {
        td.textContent = cell;
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  container.appendChild(table);
  return container;
}

// Analysis functions

function totalListeningMinutes(history) {
  let totalMs = 0;
  history.forEach(entry => {
    const ms = entry.ms_played || 0;
    if (ms > 0) totalMs += ms;
  });
  return Math.floor(totalMs / 60000);
}

function uniqueArtists(history) {
  const artists = new Set();
  history.forEach(entry => {
    const artist = entry.master_metadata_album_artist_name;
    if (artist) artists.add(artist);
  });
  return artists;
}

function uniqueSongs(history) {
  const songs = new Set();
  history.forEach(entry => {
    const track = entry.master_metadata_track_name;
    const artist = entry.master_metadata_album_artist_name;
    if (track && artist) songs.add(`${track} by ${artist}`);
  });
  return songs;
}

function topSongsByPlaytime(history, topN) {
  const playtime = {};
  history.forEach(entry => {
    const track = entry.master_metadata_track_name;
    const artist = entry.master_metadata_album_artist_name;
    const ms = entry.ms_played || 0;
    if (track && artist && ms > 0) {
      const key = `${track} by ${artist}`;
      playtime[key] = (playtime[key] || 0) + ms;
    }
  });
  const sorted = Object.entries(playtime).sort((a, b) => b[1] - a[1]).slice(0, topN);
  return sorted.map(([song, ms]) => [song, ms / 60000]);
}

function topSongsByPlaycount(history, topN) {
  const counts = {};
  history.forEach(entry => {
    if (entry.skipped) return;
    const track = entry.master_metadata_track_name;
    const artist = entry.master_metadata_album_artist_name;
    if (track && artist) {
      const key = `${track} by ${artist}`;
      counts[key] = (counts[key] || 0) + 1;
    }
  });
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, topN);
  return sorted;
}

function topSongsIncognito(history, topN) {
  const counts = {};
  history.forEach(entry => {
    if (entry.incognito_mode) {
      const track = entry.master_metadata_track_name;
      const artist = entry.master_metadata_album_artist_name;
      if (track && artist) {
        const key = `${track} by ${artist}`;
        counts[key] = (counts[key] || 0) + 1;
      }
    }
  });
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, topN);
  return sorted;
}

function mostSkippedSongs(history, topN) {
  const counts = {};
  history.forEach(entry => {
    if (entry.skipped) {
      const track = entry.master_metadata_track_name;
      const artist = entry.master_metadata_album_artist_name;
      if (track && artist) {
        const key = `${track} by ${artist}`;
        counts[key] = (counts[key] || 0) + 1;
      }
    }
  });
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, topN);
  return sorted;
}

function topArtistsByPlaytime(history, topN) {
  const playtime = {};
  history.forEach(entry => {
    const artist = entry.master_metadata_album_artist_name;
    const ms = entry.ms_played || 0;
    if (artist && ms > 0) {
      playtime[artist] = (playtime[artist] || 0) + ms;
    }
  });
  const sorted = Object.entries(playtime).sort((a, b) => b[1] - a[1]).slice(0, topN);
  return sorted.map(([artist, ms]) => [artist, ms / 60000]);
}

function topListeningStreaks(history, maxGapMinutes, topN) {
  // Build intervals
  const intervals = [];
  history.forEach(entry => {
    const tsStr = entry.ts;
    const ms = entry.ms_played || 0;
    if (!tsStr || ms <= 0) return;
    const start = new Date(tsStr);
    if (isNaN(start)) return;
    const end = new Date(start.getTime() + ms);
    intervals.push([start, end]);
  });
  intervals.sort((a, b) => a[0] - b[0]);
  const maxGapMs = maxGapMinutes * 60 * 1000;
  const streaks = [];
  let currentStart = null;
  let currentEnd = null;
  intervals.forEach(([start, end]) => {
    if (!currentEnd) {
      currentStart = start;
      currentEnd = end;
    } else {
      const gap = start - currentEnd;
      if (gap <= maxGapMs) {
        if (end > currentEnd) currentEnd = end;
      } else {
        streaks.push([currentStart, currentEnd]);
        currentStart = start;
        currentEnd = end;
      }
    }
  });
  if (currentStart && currentEnd) streaks.push([currentStart, currentEnd]);
  // Sort by duration descending
  streaks.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]));
  const top = streaks.slice(0, topN).map((streak, idx) => {
    const durationMs = streak[1] - streak[0];
    const hours = Math.floor(durationMs / (3600 * 1000));
    const minutes = Math.floor((durationMs % (3600 * 1000)) / (60 * 1000));
    return {
      rank: idx + 1,
      duration: `${hours}h ${minutes}m`,
      start: formatDateTime(streak[0]),
      end: formatDateTime(streak[1])
    };
  });
  return top;
}

function countStreaksLongerThan(history, minDurationMinutes, maxGapMinutes) {
  const intervals = [];
  history.forEach(entry => {
    const tsStr = entry.ts;
    const ms = entry.ms_played || 0;
    if (!tsStr || ms <= 0) return;
    const start = new Date(tsStr);
    if (isNaN(start)) return;
    const end = new Date(start.getTime() + ms);
    intervals.push([start, end]);
  });
  intervals.sort((a, b) => a[0] - b[0]);
  const maxGapMs = maxGapMinutes * 60 * 1000;
  const minDurMs = minDurationMinutes * 60 * 1000;
  let count = 0;
  let currentStart = null;
  let currentEnd = null;
  const addStreakIfLongEnough = () => {
    if (currentStart && currentEnd) {
      const dur = currentEnd - currentStart;
      if (dur >= minDurMs) count++;
    }
  };
  intervals.forEach(([start, end]) => {
    if (!currentEnd) {
      currentStart = start;
      currentEnd = end;
    } else {
      const gap = start - currentEnd;
      if (gap <= maxGapMs) {
        if (end > currentEnd) currentEnd = end;
      } else {
        addStreakIfLongEnough();
        currentStart = start;
        currentEnd = end;
      }
    }
  });
  addStreakIfLongEnough();
  return count;
}

function listeningTimeByHour(history) {
  const result = {};
  for (let i = 0; i < 24; i++) result[i] = 0;
  history.forEach(entry => {
    const ts = entry.ts;
    const ms = entry.ms_played || 0;
    if (!ts || ms <= 0) return;
    const date = new Date(ts);
    if (isNaN(date)) return;
    const hour = date.getUTCHours();
    result[hour] += ms / 60000;
  });
  return result;
}

function averageListeningTimeByMonth(history) {
  // year -> month -> total ms
  const ymp = {};
  history.forEach(entry => {
    const ts = entry.ts;
    const ms = entry.ms_played || 0;
    if (!ts || ms <= 0) return;
    const date = new Date(ts);
    if (isNaN(date)) return;
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth(); // 0-11
    ymp[year] = ymp[year] || {};
    ymp[year][month] = (ymp[year][month] || 0) + ms;
  });
  const monthTotals = {};
  for (let m = 0; m < 12; m++) monthTotals[m] = [];
  for (const year in ymp) {
    for (let m = 0; m < 12; m++) {
      if (ymp[year][m]) {
        monthTotals[m].push(ymp[year][m]);
      }
    }
  }
  const avgPerMonth = {};
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  for (let m = 0; m < 12; m++) {
    const arr = monthTotals[m];
    const avg = arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    avgPerMonth[monthNames[m]] = avg;
  }
  return avgPerMonth;
}

function favoriteSongPerMonth(history) {
  const monthly = {};
  history.forEach(entry => {
    const ts = entry.ts;
    const ms = entry.ms_played || 0;
    const track = entry.master_metadata_track_name;
    const artist = entry.master_metadata_album_artist_name;
    if (!ts || ms <= 0 || !track || !artist) return;
    const date = new Date(ts);
    if (isNaN(date)) return;
    const monthKey = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    const song = `${track} by ${artist}`;
    monthly[monthKey] = monthly[monthKey] || {};
    monthly[monthKey][song] = (monthly[monthKey][song] || 0) + ms;
  });
  const result = {};
  Object.keys(monthly).sort().forEach(month => {
    const songs = monthly[month];
    let topSong = null;
    let topMs = -1;
    for (const song in songs) {
      const ms = songs[song];
      if (ms > topMs) { topMs = ms; topSong = song; }
    }
    result[month] = [topSong, topMs / 60000];
  });
  return result;
}

function uniqueArtistsAndSongsPerMonth(history) {
  const data = {};
  history.forEach(entry => {
    const ts = entry.ts;
    if (!ts) return;
    const date = new Date(ts);
    if (isNaN(date)) return;
    const monthKey = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    data[monthKey] = data[monthKey] || { artists: new Set(), songs: new Set() };
    const artist = entry.master_metadata_album_artist_name;
    const track = entry.master_metadata_track_name;
    if (artist) data[monthKey].artists.add(artist);
    if (track) data[monthKey].songs.add(track);
  });
  const result = {};
  Object.keys(data).forEach(month => {
    result[month] = {
      artists: data[month].artists.size,
      songs: data[month].songs.size
    };
  });
  return result;
}

function topMostPlaysSingleDay(history, topN) {
  const counts = {};
  history.forEach(entry => {
    if (entry.skipped) return;
    const track = entry.master_metadata_track_name;
    const artist = entry.master_metadata_album_artist_name;
    const ts = entry.ts;
    if (!track || !artist || !ts) return;
    const date = new Date(ts);
    if (isNaN(date)) return;
    const day = date.toISOString().slice(0, 10);
    const key = `${track} by ${artist}`;
    const k2 = `${key}|||${day}`;
    counts[k2] = (counts[k2] || 0) + 1;
  });
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, topN);
  return sorted.map(([k, count]) => {
    const [song, day] = k.split('|||');
    return [[song, day], count];
  });
}

function topMostPlaysSingleWeek(history, topN) {
  const counts = {};
  history.forEach(entry => {
    if (entry.skipped) return;
    const track = entry.master_metadata_track_name;
    const artist = entry.master_metadata_album_artist_name;
    const ts = entry.ts;
    if (!track || !artist || !ts) return;
    const date = new Date(ts);
    if (isNaN(date)) return;
    const year = getISOWeekYear(date);
    const week = getISOWeekNumber(date);
    const keySong = `${track} by ${artist}`;
    const key = `${keySong}|||${year}|||${week}`;
    counts[key] = (counts[key] || 0) + 1;
  });
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, topN);
  return sorted.map(([k, count]) => {
    const [song, year, week] = k.split('|||');
    return [[song, parseInt(year), parseInt(week)], count];
  });
}

function findSongsListenedTogether(history, timeWindowMinutes) {
  const sortedHistory = history.filter(h => h.ts).map(h => ({ ...h, tsObj: new Date(h.ts) })).filter(h => !isNaN(h.tsObj)).sort((a, b) => a.tsObj - b.tsObj);
  const coOccurrence = {};
  for (let i = 0; i < sortedHistory.length; i++) {
    const current = sortedHistory[i];
    const windowStart = current.tsObj;
    const windowEnd = new Date(windowStart.getTime() + timeWindowMinutes * 60 * 1000);
    const windowSongs = new Set();
    for (let j = i; j < sortedHistory.length; j++) {
      const entry = sortedHistory[j];
      if (entry.tsObj > windowEnd) break;
      if (entry.skipped) continue;
      const track = entry.master_metadata_track_name;
      const artist = entry.master_metadata_album_artist_name;
      if (track && artist) {
        windowSongs.add(`${track} by ${artist}`);
      }
    }
    const songsArr = Array.from(windowSongs);
    for (let s1 = 0; s1 < songsArr.length; s1++) {
      for (let s2 = s1 + 1; s2 < songsArr.length; s2++) {
        const a = songsArr[s1];
        const b = songsArr[s2];
        coOccurrence[a] = coOccurrence[a] || {};
        coOccurrence[b] = coOccurrence[b] || {};
        coOccurrence[a][b] = (coOccurrence[a][b] || 0) + 1;
        coOccurrence[b][a] = (coOccurrence[b][a] || 0) + 1;
      }
    }
  }
  const result = {};
  Object.keys(coOccurrence).forEach(song => {
    const entries = Object.entries(coOccurrence[song]).sort((a, b) => b[1] - a[1]);
    result[song] = entries;
  });
  return result;
}

function dailyListeningTime(history) {
  const result = {};
  history.forEach(entry => {
    const ts = entry.ts;
    const ms = entry.ms_played || 0;
    if (!ts || ms <= 0) return;
    const date = new Date(ts);
    if (isNaN(date)) return;
    const day = date.toISOString().slice(0, 10);
    result[day] = (result[day] || 0) + ms / 60000;
  });
  return result;
}

function listeningTimeByWeekday(history) {
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const result = { 'Monday': 0, 'Tuesday': 0, 'Wednesday': 0, 'Thursday': 0, 'Friday': 0, 'Saturday': 0, 'Sunday': 0 };
  history.forEach(entry => {
    const ts = entry.ts;
    const ms = entry.ms_played || 0;
    if (!ts || ms <= 0) return;
    const date = new Date(ts);
    if (isNaN(date)) return;
    const dayIndex = date.getUTCDay(); // Sunday=0
    const name = days[(dayIndex + 6) % 7]; // convert to Monday=0
    result[name] += ms / 60000;
  });
  return result;
}

function skipVsPlayCounts(history) {
  let plays = 0;
  let skips = 0;
  history.forEach(entry => {
    if (entry.skipped) skips++;
    else plays++;
  });
  return [plays, skips];
}

function incognitoVsRegularCounts(history) {
  let regular = 0;
  let incognito = 0;
  history.forEach(entry => {
    if (entry.incognito_mode) incognito++;
    else regular++;
  });
  return [regular, incognito];
}

function trendingSongs(history, windowDays, topN) {
  if (history.length === 0) return [];
  // Find latest timestamp
  let latest = null;
  history.forEach(entry => {
    const ts = entry.ts;
    if (!ts) return;
    const date = new Date(ts);
    if (isNaN(date)) return;
    if (!latest || date > latest) latest = date;
  });
  if (!latest) return [];
  const endCurrent = latest;
  const startCurrent = new Date(endCurrent.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const startPrevious = new Date(startCurrent.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const countsCurrent = {};
  const countsPrev = {};
  history.forEach(entry => {
    const ts = entry.ts;
    if (!ts) return;
    const date = new Date(ts);
    if (isNaN(date)) return;
    const track = entry.master_metadata_track_name;
    const artist = entry.master_metadata_album_artist_name;
    if (!track || !artist) return;
    const key = `${track} by ${artist}`;
    if (date >= startCurrent && date <= endCurrent) {
      countsCurrent[key] = (countsCurrent[key] || 0) + 1;
    } else if (date >= startPrevious && date < startCurrent) {
      countsPrev[key] = (countsPrev[key] || 0) + 1;
    }
  });
  const deltas = [];
  const allSongs = new Set([...Object.keys(countsCurrent), ...Object.keys(countsPrev)]);
  allSongs.forEach(song => {
    const delta = (countsCurrent[song] || 0) - (countsPrev[song] || 0);
    if (delta > 0) deltas.push([song, delta]);
  });
  deltas.sort((a, b) => b[1] - a[1]);
  return deltas.slice(0, topN);
}

// Format a duration in minutes into a more readable string.  If the
// value is one hour or more, the output uses "h" and "m" units (e.g.
// 1h 25m); otherwise it returns the minutes followed by "m".
function formatMinutes(mins) {
  const total = Math.round(mins);
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

// Count plays by platform (e.g., Android, iOS, Web Player).  Unknown
// or missing platforms are grouped under 'Unknown'.
function playsByPlatform(history) {
  const counts = {};
  history.forEach(entry => {
    let p = entry.platform;
    if (!p) p = 'Unknown';
    counts[p] = (counts[p] || 0) + 1;
  });
  return counts;
}

// Count plays by connection country (two‑letter country codes).  Unknown
// or missing countries are grouped under 'Unknown'.
function playsByCountry(history) {
  const counts = {};
  history.forEach(entry => {
    let c = entry.conn_country;
    if (!c) c = 'Unknown';
    counts[c] = (counts[c] || 0) + 1;
  });
  return counts;
}

// Count plays by reason start (why the track started).  Unknown or
// missing reasons are grouped under 'Unknown'.
function playsByStartReason(history) {
  const counts = {};
  history.forEach(entry => {
    let r = entry.reason_start;
    if (!r) r = 'Unknown';
    counts[r] = (counts[r] || 0) + 1;
  });
  return counts;
}

// Count plays by reason end (why the track ended).  Unknown or
// missing reasons are grouped under 'Unknown'.
function playsByEndReason(history) {
  const counts = {};
  history.forEach(entry => {
    let r = entry.reason_end;
    if (!r) r = 'Unknown';
    counts[r] = (counts[r] || 0) + 1;
  });
  return counts;
}

// Count occurrences of shuffle mode.  Returns an object with
// 'Shuffle On' and 'Shuffle Off'.
function shuffleCounts(history) {
  const counts = { 'Shuffle On': 0, 'Shuffle Off': 0 };
  history.forEach(entry => {
    const val = entry.shuffle;
    if (val) counts['Shuffle On']++;
    else counts['Shuffle Off']++;
  });
  return counts;
}

// Count plays by offline/online status.  Returns an object with
// 'Offline', 'Online' and 'Unknown'.
function offlineCounts(history) {
  const counts = { 'Offline': 0, 'Online': 0, 'Unknown': 0 };
  history.forEach(entry => {
    const val = entry.offline;
    if (val === true) counts['Offline']++;
    else if (val === false) counts['Online']++;
    else counts['Unknown']++;
  });
  return counts;
}

// Helper: reduce a counts object into sorted top categories.  If
// more categories exist than the specified topN, the remainder are
// aggregated into an 'Other' category.
function getTopCategories(counts, topN = 10) {
  const entries = Object.entries(counts);
  entries.sort((a, b) => b[1] - a[1]);
  if (entries.length > topN) {
    const top = entries.slice(0, topN);
    const otherSum = entries.slice(topN).reduce((sum, item) => sum + item[1], 0);
    top.push(['Other', otherSum]);
    return top;
  }
  return entries;
}

// Utility: format datetime for display (YYYY-MM-DD HH:MM)
function formatDateTime(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

// Helper: get ISO week number (1-53)
function getISOWeekNumber(date) {
  const tmp = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  // Thursday in current week decides the year
  tmp.setUTCDate(tmp.getUTCDate() + 4 - (tmp.getUTCDay() || 7));
  // First week of year
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  // Calculate full weeks to nearest Thursday
  return Math.ceil((((tmp - yearStart) / 86400000) + 1) / 7);
}
// Helper: get ISO week year (the year the week belongs to)
function getISOWeekYear(date) {
  const tmp = new Date(date.valueOf());
  tmp.setDate(tmp.getDate() + 4 - (tmp.getDay() || 7));
  return tmp.getFullYear();
}

// --- Share modal helpers ---------------------------------------------------

// Close the share dialog
function closeShareModal() {
  document.getElementById('shareModal').style.display = 'none';
}

// Copy the share URL to the clipboard
async function copyShareUrl() {
  try {
    await navigator.clipboard.writeText(globalShareUrl);
    alert('Share link copied to clipboard!');
  } catch (err) {
    console.warn('Clipboard write failed:', err);
    alert('Error copying share link to clipboard.');
  }
}

// Download the results as a standalone HTML file
async function downloadResultsHtml() {
  try {
    const cssText = await fetch('css/style.css').then(r => r.text());
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>ListenStats Results</title><style>${cssText}</style></head><body>${document.getElementById('results').innerHTML}</body></html>`;
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'listen-stats.html';
    document.body.appendChild(a);
    a.click();
    URL.revokeObjectURL(url);
    a.remove();
  } catch (err) {
    console.error('Failed to create HTML download:', err);
    alert('Unable to generate HTML file.');
  }
}

// Create a print-ready window for saving to PDF
async function downloadResultsPdf() {
  try {
    const cssText = await fetch('css/style.css').then(r => r.text());
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>ListenStats Results</title><style>${cssText}</style></head><body>${document.getElementById('results').innerHTML}</body></html>`;
    const win = window.open('', '_blank');
    win.document.write(html);
    win.document.close();
    win.focus();
    win.print();
  } catch (err) {
    console.error('Failed to open print window:', err);
    alert('Unable to create PDF.');
  }
}