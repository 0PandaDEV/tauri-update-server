import express from 'express';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { parse as yamlParse } from 'yaml';
import QuickLRU from 'quick-lru';

const config = yamlParse(fs.readFileSync('./config.yml', 'utf8')) as any;

const app = express();
const PORT = 3000;

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
  'windows-x86_64': config.enabled_platforms.windows_x86 !== false,
  'windows-aarch64': config.enabled_platforms.windows_arm64 !== false,
  'darwin-x86_64': config.enabled_platforms.macos_intel !== false,
  'darwin-aarch64': config.enabled_platforms.macos_silicon !== false,
};

const readFileAsync = promisify(fs.readFile);
const writeFileAsync = promisify(fs.writeFile);

interface File {
  name: string;
  url: string;
}

interface ETagData {
  releases: string;
  archives?: {[tag: string]: string};
  signatures?: {[url: string]: string};
}

const cache = new QuickLRU<string, any>({ maxSize: 1000 });

const ensureFileExists = async (filePath: string) => {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
  } catch {
    console.log(`File not found: ${filePath}, creating...`);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, '{}');
  }
};

async function fetchGitHubData(etagData: ETagData) {
  const releasesResponse = await axios.get(GITHUB_RELEASES_URL, {
    headers: { 'If-None-Match': etagData.releases || '' },
    validateStatus: (status) => status >= 200 && status < 300 || status === 304
  });
  
  if (releasesResponse.status === 304) {
    return cache.get('cacheData') || JSON.parse(await readFileAsync(CACHE_FILE, { encoding: 'utf8' }));
  }
  
  const latestRelease = releasesResponse.data[0];
  etagData.releases = releasesResponse.headers.etag;
  
  if (!etagData.archives) etagData.archives = {};
  if (!etagData.signatures) etagData.signatures = {};

  const filesResponse = await axios.get(`${GITHUB_ARCHIVES_URL}${latestRelease.tag_name}`, {
    headers: { 'If-None-Match': etagData.archives[latestRelease.tag_name] || '' },
    validateStatus: (status) => status >= 200 && status < 300 || status === 304
  });
  
  let files: File[] = [];
  
  if (filesResponse.status !== 304) {
    etagData.archives[latestRelease.tag_name] = filesResponse.headers.etag;
    files = filesResponse.data.map((file: any) => ({
      name: file.name,
      url: `https://github.com/${GITHUB_ARCHIVE_REPO}/raw/main/${latestRelease.tag_name}/${file.name}`
    }));
  } else {
    const currentData = cache.get('cacheData') || JSON.parse(await readFileAsync(CACHE_FILE, { encoding: 'utf8' }));
    if (currentData && currentData.version === latestRelease.tag_name) {
      return currentData;
    }
  }

  const platformFiles: { [key: string]: { signature: string; url: string; } } = {};
  await Promise.all(files.map(async (file: File) => {
    const platformKey = determinePlatform(file.name);

    if (ENABLED_PLATFORMS[platformKey as keyof typeof ENABLED_PLATFORMS]) {
      if (file.name.endsWith('.sig')) {
        if (platformFiles[platformKey]) {
          platformFiles[platformKey].signature = await fetchSignature(file.url, etagData);
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
  await writeFileAsync(ETAG_FILE, JSON.stringify(etagData));
  
  return cacheData;
}

function determinePlatform(filename: string): string {
  if (filename.endsWith('.sig')) {
    return determinePlatform(filename.slice(0, -4));
  } else if (filename.endsWith('.AppImage')) {
    return 'linux-x86_64';
  } else if (filename.endsWith('.msi')) {
    if (filename.includes('arm64')) {
      return 'windows-aarch64';
    }
    return 'windows-x86_64';
  } else if (filename.endsWith('_intel.app.tar.gz')) {
    return 'darwin-x86_64';
  } else if (filename.endsWith('_silicon.app.tar.gz')) {
    return 'darwin-aarch64';
  }
  return 'unknown';
}

async function fetchSignature(url: string, etagData: ETagData): Promise<string> {
  try {
    const response = await axios.get(url, {
      headers: { 'If-None-Match': etagData.signatures?.[url] || '' },
      validateStatus: (status) => status >= 200 && status < 300 || status === 304
    });
    
    if (response.status === 304) {
      const cacheData = cache.get('cacheData') || JSON.parse(await readFileAsync(CACHE_FILE, { encoding: 'utf8' }));
      const platformKey = determinePlatform(url.split('/').pop() || '');
      return cacheData?.platforms?.[platformKey]?.signature || '';
    }
    
    if (!etagData.signatures) etagData.signatures = {};
    etagData.signatures[url] = response.headers.etag;
    
    return response.data;
  } catch (error) {
    console.error(`Error fetching signature: ${error}`);
    return '';
  }
}

const getTime = () => {
  const now = new Date().toLocaleString("en-US", { timeZone: "Europe/Zurich", hour12: true, hourCycle: 'h12' });
  const [date, timeWithPeriod] = now.split(', ');
  const [month, day, year] = date.split('/');
  const [time] = timeWithPeriod.split(' ');
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
    if (!cacheData || !Object.keys(cacheData).length) {
      console.log(`${getTime()} Cache is empty, fetching data.`);
      try {
        cacheData = await fetchGitHubData(etagData);
        cache.set('cacheData', cacheData);
        if (!isBetterUptimeBot) {
          statsData.fetches = (statsData.fetches || 0) + 1;
          cache.set('statsData', statsData);
        }
        console.log(`${getTime()} Fetching new data - C:${statsData.cacheHits || 0} : F:${statsData.fetches || 0}`);
      } catch (fetchError: any) {
        console.error(`${getTime()} Error fetching new data: ${fetchError}`);
        if (fetchError.response && fetchError.response.status === 403) {
          res.json(cacheData || {});
          return;
        }
      }
    } else {
      try {
        const updatedData = await fetchGitHubData(etagData);
        if (updatedData !== cacheData) {
          cacheData = updatedData;
          cache.set('cacheData', cacheData);
          if (!isBetterUptimeBot) {
            statsData.fetches = (statsData.fetches || 0) + 1;
            cache.set('statsData', statsData);
          }
          console.log(`${getTime()} Fetching new data - C:${statsData.cacheHits || 0} : F:${statsData.fetches || 0}`);
        } else {
          if (!isBetterUptimeBot) {
            statsData.cacheHits = (statsData.cacheHits || 0) + 1;
            cache.set('statsData', statsData);
          }
          console.log(`${getTime()} Using cached data - C:${statsData.cacheHits || 0} : F:${statsData.fetches || 0}`);
        }
      } catch (error: any) {
        console.error(`${getTime()} Error checking for updates: ${error}`);
        if (!isBetterUptimeBot) {
          statsData.cacheHits = (statsData.cacheHits || 0) + 1;
          cache.set('statsData', statsData);
        }
      }
    }

    if (!isBetterUptimeBot) {
      await writeFileAsync(STATS_FILE, JSON.stringify(statsData));
    }
    res.json(cacheData);
  } catch (error: any) {
    console.error(`${getTime()} Error handling request: ${error}`);
    if (error.response && error.response.status === 403) {
      console.error(`${getTime()} SERVER IS RATELIMITED`);
    }
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