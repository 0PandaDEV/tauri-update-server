import express from 'express';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { parse as yamlParse } from 'yaml';
import QuickLRU from 'quick-lru';

const config = yamlParse(fs.readFileSync('./config.yml', 'utf8')) as any;

const app = express();
const PORT = config.port || 3000;

if (!config.github.release_repo || !config.github.archive_repo) {
  throw new Error('GitHub release_repo and archive_repo must be set in the config.yml file');
}

const GITHUB_RELEASES_URL = `https://api.github.com/repos/${config.github.release_repo}/releases`;
const GITHUB_ARCHIVES_URL = `https://api.github.com/repos/${config.github.archive_repo}/contents/`;
const GITHUB_ARCHIVE_REPO = config.github.archive_repo;

const CACHE_FILE = './cache/data.json';
const STATS_FILE = './cache/stats.json';
const ETAG_FILE = './cache/etag.json';

const ENABLED_PLATFORMS = {
  'linux-x86_64': config.enabled_platforms.linux !== false,
  'windows-x86_64': config.enabled_platforms.windows !== false,
  'darwin-x86_64': config.enabled_platforms.macos_intel !== false,
  'darwin-aarch64': config.enabled_platforms.macos_silicon !== false,
};

const readFileAsync = promisify(fs.readFile);
const writeFileAsync = promisify(fs.writeFile);

interface File {
  name: string;
  url: string;
}

const cache = new QuickLRU<string, any>({ maxSize: 1000 });

const ensureFileExists = async (filePath: string) => {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
  } catch (error) {
    console.log(`File not found: ${filePath}, creating...`);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, '{}');
  }
};

async function fetchGitHubData() {
  const releasesResponse = await axios.get(GITHUB_RELEASES_URL);
  const latestRelease = releasesResponse.data[0];
  const etag = releasesResponse.headers.etag;

  await writeFileAsync(ETAG_FILE, JSON.stringify({ etag }));

  const filesResponse = await axios.get(`${GITHUB_ARCHIVES_URL}${latestRelease.tag_name}`);
  const files: File[] = filesResponse.data.map((file: any) => ({
    name: file.name,
    url: `https://github.com/${GITHUB_ARCHIVE_REPO}/raw/main/${latestRelease.tag_name}/${file.name}`
  }));

  const platformFiles: { [key: string]: { signature: string; url: string; } } = {};
  await Promise.all(files.map(async (file: File) => {
    const platformKey = determinePlatform(file.name);

    if (ENABLED_PLATFORMS[platformKey as keyof typeof ENABLED_PLATFORMS]) {
      if (file.name.endsWith('.sig')) {
        if (platformFiles[platformKey]) {
          platformFiles[platformKey].signature = await fetchSignature(file.url);
        }
      } else {
        if (!platformFiles[platformKey]) {
          platformFiles[platformKey] = { signature: '', url: file.url };
        }
      }
    }
  }));

  const orderedPlatforms = Object.fromEntries(
    Object.entries(ENABLED_PLATFORMS)
      .filter(([_, enabled]) => enabled)
      .map(([key]) => [key, platformFiles[key] || {}])
  );

  const cacheData = {
    version: latestRelease.tag_name,
    notes: "A new version is available",
    pub_date: latestRelease.published_at,
    platforms: orderedPlatforms
  };
  await writeFileAsync(CACHE_FILE, JSON.stringify(cacheData));
  return cacheData;
}

function determinePlatform(filename: string): string {
  if (filename.endsWith('.sig')) {
    return determinePlatform(filename.slice(0, -4));
  } else if (filename.endsWith('.AppImage')) {
    return 'linux-x86_64';
  } else if (filename.endsWith('.msi')) {
    return 'windows-x86_64';
  } else if (filename.endsWith('_intel.app.tar.gz')) {
    return 'darwin-x86_64';
  } else if (filename.endsWith('_silicon.app.tar.gz')) {
    return 'darwin-aarch64';
  }
  return 'unknown';
}

async function fetchSignature(url: string): Promise<string> {
  const response = await axios.get(url);
  return response.data;
}

const getTime = () => {
  const now = new Date().toLocaleString("en-US", { timeZone: "Europe/Zurich", hour12: true, hourCycle: 'h12' });
  const [date, timeWithPeriod] = now.split(', ');
  const [month, day, year] = date.split('/');
  const [time, period] = timeWithPeriod.split(' ');
  const [hours, minutes, seconds] = time.split(':');
  return `[${day.padStart(2, '0')}.${month.padStart(2, '0')}.${year} ${hours}:${minutes}:${seconds}]`;
};

app.get('/', async (req: express.Request, res: express.Response) => {
  await ensureFileExists(CACHE_FILE);
  await ensureFileExists(STATS_FILE);
  await ensureFileExists(ETAG_FILE);

  let cacheData = cache.get('cacheData') || JSON.parse(await readFileAsync(CACHE_FILE, { encoding: 'utf8' }));
  let statsData = cache.get('statsData') || JSON.parse(await readFileAsync(STATS_FILE, { encoding: 'utf8' }));
  let etagData = cache.get('etagData') || JSON.parse(await readFileAsync(ETAG_FILE, { encoding: 'utf8' }));

  const userAgent = req.get('User-Agent') || '';
  const isBetterUptimeBot = userAgent.includes('Better Uptime Bot');

  console.log(`${getTime()} User-Agent: ${userAgent}`);

  try {
    const latestReleaseResponse = await axios.get(GITHUB_RELEASES_URL, {
      headers: { 'If-None-Match': etagData.etag || '' },
      validateStatus: function (status: number) {
        return status >= 200 && status < 300 || status === 304;
      }
    });

    const cacheIsOutdated = latestReleaseResponse.status !== 304 &&
      latestReleaseResponse.data &&
      latestReleaseResponse.data[0] &&
      latestReleaseResponse.data[0].name !== cacheData?.version;

    if (cacheIsOutdated) {
      console.log(`${getTime()} Cache is outdated or missing, fetching data.`);
      try {
        cacheData = await fetchGitHubData();
        cache.set('cacheData', cacheData);
        if (!isBetterUptimeBot) {
          statsData.fetches = (statsData.fetches || 0) + 1;
          cache.set('statsData', statsData);
        }
        console.log(`${getTime()} Fetching new data - C:${statsData.cacheHits || 0} : F:${statsData.fetches || 0}`);
      } catch (fetchError: any) {
        if (fetchError.response && fetchError.response.status === 403) {
          res.json(cacheData || {});
          return;
        } else {
          console.error(`${getTime()} Error fetching new data: ${fetchError}`);
        }
      }
    } else {
      if (!isBetterUptimeBot) {
        statsData.cacheHits = (statsData.cacheHits || 0) + 1;
        cache.set('statsData', statsData);
      }
      console.log(`${getTime()} Using cached data - C:${statsData.cacheHits || 0} : F:${statsData.fetches || 0}`);
    }

    if (!isBetterUptimeBot) {
      await writeFileAsync(STATS_FILE, JSON.stringify(statsData));
    }
    res.json(cacheData);
  } catch (error: any) {
    console.error(`${getTime()} SERVER IS RATELIMITED: ${error}`);
    if (!isBetterUptimeBot) {
      statsData.cacheHits = statsData.cacheHits ? statsData.cacheHits + 1 : 1;
      cache.set('statsData', statsData);
      await writeFileAsync(STATS_FILE, JSON.stringify(statsData));
    }
    console.log(`${getTime()} Using cached data - C:${statsData.cacheHits} : F:${statsData.fetches}`);
    res.json(cacheData || {});
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});