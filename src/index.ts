import express from 'express';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

const app = express();
const PORT = 3004;
const GITHUB_RELEASES_URL = 'https://api.github.com/repos/vleerapp/vleer/releases';
const GITHUB_ARCHIVES_URL = 'https://api.github.com/repos/vleerapp/archives/contents/';
const CACHE_FILE = './cache/data.json';
const STATS_FILE = './cache/stats.json';
const ETAG_FILE = './cache/etag.json';

const readFileAsync = promisify(fs.readFile);
const writeFileAsync = promisify(fs.writeFile);

interface Release {
  tag_name: string;
  published_at: string;
}

interface File {
  name: string;
  signature: string;
  url: string;
}

interface PlatformFiles {
  [key: string]: { signature: string; url: string };
}

interface CacheData {
  version: string;
  notes: string;
  pub_date: string;
  platforms: PlatformFiles;
}

interface StatsData {
  cacheHits: number;
  fetches: number;
}

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
    signature: '',
    url: `https://github.com/vleerapp/archives/raw/main/${latestRelease.tag_name}/${file.name}`
  }));

  const platformFiles: { [key: string]: { signature: string; url: string; } } = {};
  await Promise.all(files.map(async (file: File) => {
    const platformKey = determinePlatform(file.name);

    if (file.name.endsWith('.sig')) {
      const baseFileName = file.name.replace('.sig', '');
      const baseFileKey = determinePlatform(baseFileName);

      if (platformFiles[baseFileKey]) {
        platformFiles[baseFileKey].signature = await fetchSignature(file.url);
      }
    } else {
      if (!platformFiles[platformKey]) {
        platformFiles[platformKey] = { signature: '', url: file.url };
      }
    }
  }));

  const orderedPlatforms = {
    'linux-x86_64': platformFiles['linux-x86_64'] || {},
    'windows-x86_64': platformFiles['windows-x86_64'] || {},
    'darwin-x86_64': platformFiles['darwin-x86_64'] || {},
    'darwin-aarch64': platformFiles['darwin-aarch64'] || {}
  };

  const cacheData = {
    version: latestRelease.tag_name,
    notes: "A new version of Vleer is available",
    pub_date: latestRelease.published_at,
    platforms: orderedPlatforms
  };
  await writeFileAsync(CACHE_FILE, JSON.stringify(cacheData));
  return cacheData;
}

function determinePlatform(filename: string): string {
  if (filename.endsWith('.AppImage')) {
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

  let cacheData = JSON.parse(await readFileAsync(CACHE_FILE, { encoding: 'utf8' }));
  let statsData = JSON.parse(await readFileAsync(STATS_FILE, { encoding: 'utf8' }));
  let etagData = JSON.parse(await readFileAsync(ETAG_FILE, { encoding: 'utf8' }));

  const userAgent = req.get('User-Agent') || '';
  const isBetterUptimeBot = userAgent.includes('Better Uptime Bot');

  console.log(`${getTime()} User-Agent: ${userAgent}`);

  try {
    let etagData = JSON.parse(await readFileAsync(ETAG_FILE, { encoding: 'utf8' }));

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
        if (!isBetterUptimeBot) {
          statsData.fetches = (statsData.fetches || 0) + 1;
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
      await writeFileAsync(STATS_FILE, JSON.stringify(statsData));
    }
    console.log(`${getTime()} Using cached data - C:${statsData.cacheHits} : F:${statsData.fetches}`);
    res.json(cacheData || {});
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});