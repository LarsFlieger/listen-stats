/*
 * Web Worker for Spotify History Analyzer
 *
 * Performs computationally heavy analysis in a separate thread to keep
 * the UI responsive. Receives messages containing the filtered
 * history data, the desired number of top items, and the maximum
 * allowed gap for listening streaks. Sends back progress updates
 * during computation and finally posts a 'done' message with the
 * results object.
 */

self.addEventListener('message', (event) => {
  const { history, topN, streakGap } = event.data;
  // Guard
  if (!history || !Array.isArray(history)) {
    self.postMessage({ type: 'error', error: 'Invalid history data' });
    return;
  }
  // Wrap computation in async function to use await for yielding
  (async () => {
    try {
      const totalEntries = history.length;
      // Convert topN to integer and clamp between 1 and 100.  Default to 100
      // when no value is provided.
      const maxTop = Math.min(Math.max(parseInt(topN || 100), 1), 100);
      const maxStreakGap = parseInt(streakGap || 30);
      // Helper to post progress. Ensure percent between 0 and 1.
      const reportProgress = (percent, msg) => {
        self.postMessage({ type: 'progress', percent: Math.min(Math.max(percent, 0), 1), msg });
      };
      // Start progress
      reportProgress(0.0, 'Starting analysis');
      // ----- Basic aggregates -----
      let totalMs = 0;
      const artistPlaytime = new Map();
      const artistSet = new Set();
      const songPlaytime = new Map();
      const songPlaycount = new Map();
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
      // Helper to increment map value
      function incMap(map, key, inc=1) {
        map.set(key, (map.get(key) || 0) + inc);
      }
      // Determine latest date for trending
      let latestDate = null;
      // Preprocess history: iterate once to compute many stats
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
          }
        }
        // Count incognito plays
        if (entry.incognito_mode) {
          incognitoCountMap.set(track && artist ? `${track} by ${artist}` : 'Unknown', (incognitoCountMap.get(track && artist ? `${track} by ${artist}` : 'Unknown') || 0) + 1);
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
        // Artist playtime
        if (artist && ms > 0) {
          artistPlaytime.set(artist, (artistPlaytime.get(artist) || 0) + ms);
        }
        // Platform, country, reasons, shuffle, offline
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
        if (entry.incognito_mode) {
          incognitoCount++;
        } else {
          regularCount++;
        }
        // Daily and weekday aggregates
        if (ms > 0 && entry.ts) {
          const dt = new Date(entry.ts);
          if (!isNaN(dt)) {
            // latest date
            if (!latestDate || dt > latestDate) latestDate = dt;
            const dateKey = dt.toISOString().substring(0, 10);
            dailyMs.set(dateKey, (dailyMs.get(dateKey) || 0) + ms);
            const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
            const wd = dayNames[dt.getDay()];
            weekdayMs.set(wd, (weekdayMs.get(wd) || 0) + ms);
          }
        }
      }
      reportProgress(0.1, 'Computed basic aggregates');
      // Unique songs count
      const uniqueSongsCount = songPlaytime.size;
      const uniqueArtistsCount = artistSet.size;
      // Top songs by playtime (convert ms to minutes)
      let topPlaytimeArr = Array.from(songPlaytime.entries());
      topPlaytimeArr.sort((a,b) => b[1] - a[1]);
      const topPlaytime = topPlaytimeArr.map(([song, ms]) => [song, ms / 60000]);
      // Top songs by playcount
      let topPlaycountArr = Array.from(songPlaycount.entries());
      topPlaycountArr.sort((a,b) => b[1] - a[1]);
      const topPlaycount = topPlaycountArr;
      // Incognito top songs
      let incognitoArr = Array.from(incognitoCountMap.entries());
      incognitoArr.sort((a,b) => b[1] - a[1]);
      const incognitoTop = incognitoArr;
      // Skipped songs top
      let skippedArr = Array.from(skipCountMap.entries());
      skippedArr.sort((a,b) => b[1] - a[1]);
      const skippedTop = skippedArr;
      // Top artists by playtime
      let topArtistsArr = Array.from(artistPlaytime.entries());
      topArtistsArr.sort((a,b) => b[1] - a[1]);
      const topArtists = topArtistsArr.map(([artist, ms]) => [artist, ms / 60000]);
      reportProgress(0.2, 'Computed top songs and artists');
      // Listening streaks
      // Build intervals of [start, end]
      const intervals = [];
      for (let entry of history) {
        const ms = entry.ms_played || 0;
        if (ms <= 0) continue;
        const ts = entry.ts;
        if (!ts) continue;
        const start = new Date(ts);
        if (isNaN(start)) continue;
        const end = new Date(start.getTime() + ms);
        intervals.push([start, end]);
      }
      intervals.sort((a,b) => a[0] - b[0]);
      const maxGapMs = maxStreakGap * 60 * 1000;
      const streaksList = [];
      let currentStart = null;
      let currentEnd = null;
      for (let [start, end] of intervals) {
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
      // Sort streaks by duration
      streaksList.sort((a,b) => (b[1] - b[0]) - (a[1] - a[0]));
      const topStreaks = streaksList.map((streak, idx) => {
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
      // Compute streak counts over thresholds (1..10 hours) with 10 minute gap
      // Build durations list
      const streakDurations = streaksList.map(([s,e]) => e - s);
      const streakCounts = [];
      for (let h = 1; h <= Math.min(10, maxTop); h++) {
        const thresholdMs = h * 60 * 60 * 1000;
        let count = 0;
        for (const dur of streakDurations) {
          if (dur >= thresholdMs) count++;
        }
        const label = `${h}h:${'00'}`;
        streakCounts.push({ threshold: label, count });
      }
      reportProgress(0.3, 'Computed streaks');
      // Listening time by hour
      const byHour = {};
      for (let [key, ms] of Object.entries({})) {
        // dummy placeholder
      }
      // We'll fill byHour using a simple loop
      for (let entry of history) {
        const ms = entry.ms_played || 0;
        if (ms <= 0 || !entry.ts) continue;
        const dt = new Date(entry.ts);
        if (isNaN(dt)) continue;
        const hour = dt.getHours();
        byHour[hour] = (byHour[hour] || 0) + ms / 60000;
      }
      // Fill missing hours with 0
      for (let h = 0; h < 24; h++) {
        if (!(h in byHour)) byHour[h] = 0;
      }
      // Average listening time by month across years
      const yearMonthPlaytime = new Map(); // year -> month -> ms
      for (let entry of history) {
        const ms = entry.ms_played || 0;
        if (ms <= 0 || !entry.ts) continue;
        const dt = new Date(entry.ts);
        if (isNaN(dt)) continue;
        const year = dt.getFullYear();
        const month = dt.getMonth() + 1; // 1-12
        if (!yearMonthPlaytime.has(year)) yearMonthPlaytime.set(year, new Map());
        const mMap = yearMonthPlaytime.get(year);
        mMap.set(month, (mMap.get(month) || 0) + ms);
      }
      const monthTotals = new Map(); // month -> [ms list]
      for (let [year, mMap] of yearMonthPlaytime.entries()) {
        for (let month = 1; month <= 12; month++) {
          const ms = mMap.get(month);
          if (ms) {
            if (!monthTotals.has(month)) monthTotals.set(month, []);
            monthTotals.get(month).push(ms);
          }
        }
      }
      const avgByMonth = {};
      for (let month = 1; month <= 12; month++) {
        const plays = monthTotals.get(month) || [];
        if (plays.length > 0) {
          const avg = plays.reduce((a,b) => a + b, 0) / plays.length;
          avgByMonth[month] = avg;
        } else {
          avgByMonth[month] = 0;
        }
      }
      reportProgress(0.35, 'Computed time patterns');
      // Favorite song per month and unique artists/songs per month
      const monthlySongPlaytime = new Map(); // monthKey -> map(song->ms)
      const uniquesMonth = {};
      for (let entry of history) {
        const ms = entry.ms_played || 0;
        if (ms <= 0 || !entry.ts) continue;
        const track = entry.master_metadata_track_name;
        const artist = entry.master_metadata_album_artist_name;
        if (!track || !artist) continue;
        const dt = new Date(entry.ts);
        if (isNaN(dt)) continue;
        const monthKey = `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}`;
        if (!monthlySongPlaytime.has(monthKey)) monthlySongPlaytime.set(monthKey, new Map());
        const mMap = monthlySongPlaytime.get(monthKey);
        const songKey = `${track} by ${artist}`;
        mMap.set(songKey, (mMap.get(songKey) || 0) + ms);
        // uniques
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
        for (let [song, ms] of mMap.entries()) {
          if (ms > maxMs) {
            maxMs = ms;
            favSong = song;
          }
        }
        favorites[month] = [favSong, maxMs / 60000];
      });
      // Convert uniques sets to counts
      const uniquesMonthCounts = {};
      for (let month in uniquesMonth) {
        uniquesMonthCounts[month] = {
          artists: uniquesMonth[month].artists.size,
          songs: uniquesMonth[month].songs.size
        };
      }
      reportProgress(0.4, 'Computed monthly favourites and uniques');
      // Top plays single day
      const playsBySongDay = new Map();
      const playsBySongWeek = new Map();
      for (let entry of history) {
        const track = entry.master_metadata_track_name;
        const artist = entry.master_metadata_album_artist_name;
        if (!track || !artist) continue;
        if (entry.skipped) continue;
        const songKey = `${track} by ${artist}`;
        const dt = new Date(entry.ts);
        if (isNaN(dt)) continue;
        // Day
        const date = dt.toISOString().substring(0,10);
        const dayKey = `${songKey}|||${date}`;
        playsBySongDay.set(dayKey, (playsBySongDay.get(dayKey) || 0) + 1);
        // Week
        const weekNum = getISOWeekNumber(dt);
        const weekYear = getISOWeekYear(dt);
        const weekKey = `${songKey}|||${weekYear}|||${weekNum}`;
        playsBySongWeek.set(weekKey, (playsBySongWeek.get(weekKey) || 0) + 1);
      }
      // Sort day and week
      const topDayArr = Array.from(playsBySongDay.entries()).sort((a,b) => b[1] - a[1]);
      const topWeekArr = Array.from(playsBySongWeek.entries()).sort((a,b) => b[1] - a[1]);
      reportProgress(0.45, 'Computed plays per day/week');
      // Co‑listening: songs often listened together within 30 minute window.  Only
      // consider co‑occurrences where the base song is among the top
      // songs by playtime.  This limits the computation and focuses on
      // meaningful pairs.
      const coListens = {};
      try {
        // Determine base songs (topN for co‑listening).  We cap this at
        // 50 to limit computational cost.
        const baseSongs = new Set(topPlaytime.slice(0, Math.min(50, maxTop)).map(item => item[0]));
        // Prepare sorted history by timestamp with song names (non‑skipped entries)
        const sortedHistory = history
          .filter(e => {
            const track = e.master_metadata_track_name;
            const artist = e.master_metadata_album_artist_name;
            return track && artist && !e.skipped;
          })
          .map(e => {
            const dt = new Date(e.ts);
            return {
              ts: dt,
              song: `${e.master_metadata_track_name} by ${e.master_metadata_album_artist_name}`
            };
          })
          .filter(e => !isNaN(e.ts))
          .sort((a,b) => a.ts - b.ts);
        const n = sortedHistory.length;
        for (let i = 0; i < n; i++) {
          const baseSong = sortedHistory[i].song;
          if (!baseSongs.has(baseSong)) continue;
          const windowStart = sortedHistory[i].ts;
          const windowEnd = new Date(windowStart.getTime() + 30 * 60 * 1000);
          const uniqueSongs = new Set();
          // Collect songs within the window
          for (let j = i; j < n && sortedHistory[j].ts <= windowEnd; j++) {
            uniqueSongs.add(sortedHistory[j].song);
          }
          // For each pair, update co-listens
          uniqueSongs.forEach(song2 => {
            if (song2 === baseSong) return;
            if (!coListens[baseSong]) coListens[baseSong] = {};
            coListens[baseSong][song2] = (coListens[baseSong][song2] || 0) + 1;
          });
        }
        // Sort each list
        for (let song in coListens) {
          const entries = Object.entries(coListens[song]);
          entries.sort((a,b) => b[1] - a[1]);
          coListens[song] = entries;
        }
      } catch (e) {
        // If co‑listening fails for any reason, leave result empty
        console.error('Co‑listening computation failed in worker:', e);
      }
      reportProgress(0.55, 'Computed co‑listening');
      // Daily listening time (convert to minutes)
      const dailyMinutes = {};
      const sortedDaily = Array.from(dailyMs.entries()).sort((a,b) => a[0].localeCompare(b[0]));
      sortedDaily.forEach(([date, ms]) => {
        dailyMinutes[date] = ms / 60000;
      });
      // Weekday minutes
      const weekdayMinutes = {};
      for (let [day, ms] of weekdayMs.entries()) {
        weekdayMinutes[day] = ms / 60000;
      }
      reportProgress(0.6, 'Computed daily and weekday stats');
      // Trending songs: compare last 30 days vs previous 30 days
      const trendingList = [];
      if (latestDate) {
        const oneDayMs = 24 * 60 * 60 * 1000;
        const startLast30 = new Date(latestDate.getTime() - 30 * oneDayMs);
        const startPrev30 = new Date(startLast30.getTime() - 30 * oneDayMs);
        const last30Counts = new Map();
        const prev30Counts = new Map();
        for (let entry of history) {
          const ts = entry.ts;
          const track = entry.master_metadata_track_name;
          const artist = entry.master_metadata_album_artist_name;
          if (!ts || !track || !artist) continue;
          const dt = new Date(ts);
          if (isNaN(dt)) continue;
          const songKey = `${track} by ${artist}`;
          if (dt > startLast30) {
            last30Counts.set(songKey, (last30Counts.get(songKey) || 0) + 1);
          } else if (dt > startPrev30) {
            prev30Counts.set(songKey, (prev30Counts.get(songKey) || 0) + 1);
          }
        }
        // Compute deltas
        for (let [song, count] of last30Counts.entries()) {
          const prev = prev30Counts.get(song) || 0;
          const delta = count - prev;
          if (delta > 0) trendingList.push([song, delta]);
        }
        trendingList.sort((a,b) => b[1] - a[1]);
      }
      reportProgress(0.65, 'Computed trending songs');
      // Convert counts maps to plain objects for serialization
      function mapToObj(map) {
        const obj = {};
        for (let [key, val] of map.entries()) obj[key] = val;
        return obj;
      }
      const results = {
        totalMinutes: Math.floor(totalMs / 60000),
        uniqueArtists: uniqueArtistsCount,
        uniqueSongs: uniqueSongsCount,
        topPlaytime: topPlaytime,
        topPlaycount: topPlaycount,
        incognitoTop: incognitoTop,
        skippedTop: skippedTop,
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
        offlineCounts: mapToObj(offlineCounts)
      };
      reportProgress(0.9, 'Packaging results');
      // Done
      self.postMessage({ type: 'done', results });
    } catch (err) {
      console.error(err);
      self.postMessage({ type: 'error', error: err.message || err.toString() });
    }
  })();
});

// Helper: format a Date into YYYY-MM-DD HH:MM (used in streaks)
function formatDateTime(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

// ISO week number and year (matching Python's isocalendar)
function getISOWeekNumber(date) {
  const tmp = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  tmp.setUTCDate(tmp.getUTCDate() + 4 - (tmp.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  return Math.ceil((((tmp - yearStart) / 86400000) + 1) / 7);
}
function getISOWeekYear(date) {
  const tmp = new Date(date.valueOf());
  tmp.setDate(tmp.getDate() + 4 - (tmp.getDay() || 7));
  return tmp.getFullYear();
}