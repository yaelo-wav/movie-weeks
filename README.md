# Opening Weeks

Films opening in Dutch cinemas, week by week, with a personal watchlist. Runs as a home-screen app on iPhone, hosted for free on GitHub Pages.

- **Dutch release dates** come from [Filmvandaag](https://www.filmvandaag.nl/nieuwefilms).
- **Posters, synopsis, cast and US dates** come from [TMDB](https://www.themoviedb.org).
- **Showtimes** for Pathé De Kuip and Pathé Schouwburgplein (Rotterdam) come from Pathé's website and power the
  *Double screenings* tab: pairs of watchlist films where the second starts at most 30 minutes after the first ends
  (or up to 15 minutes before, since the listed start time includes trailers).
- A GitHub Action rebuilds `docs/data/releases.json` and `docs/data/showtimes.json` every 6 hours and republishes the site.
- Your watchlist is stored on your phone (no account, no server).

## One-time setup

1. **Put the project on GitHub** (GitHub Desktop):
   File → Add local repository → choose this `movie-weeks` folder → click *create a repository* → Create repository.
   Commit everything, then **Publish repository** with *Keep this code private* **unchecked** (free GitHub Pages needs a public repo).
   `config.json` holds your TMDB key and is ignored by git, so it is never uploaded.
2. **Add your TMDB key as a secret**: on github.com open the repo → Settings → Secrets and variables → Actions → *New repository secret*.
   Name `TMDB_API_KEY`, value: the key from `config.json`.
3. **Turn on Pages**: Settings → Pages → Build and deployment → Source: **GitHub Actions**.
4. **Run it once**: Actions tab → *Update releases* → *Run workflow*. After about a minute the site is live at
   `https://<your-github-username>.github.io/movie-weeks/`.
5. **On your iPhone**: open that address in Safari → Share → **Add to Home Screen**.

After that it updates itself every 6 hours. To publish changes to the app, commit and push in GitHub Desktop.

## On your PC

- Preview: `node serve.js`, then open http://localhost:4173
- Refresh the data by hand: `node scripts/build-data.mjs` (reads the key from `config.json`)

## Notes

- The watchlist lives in the home-screen app's storage. Deleting the app from your home screen deletes the watchlist.
- Films without a TMDB match (mostly small Dutch titles) show without a poster.
- GitHub pauses scheduled Actions in repos with no activity for 60 days; the data commits every 6 hours count as activity.
