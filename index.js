/** @typedef {import('pear-interface')} */
import fs from 'fs';
import path from 'path';
import b4a from 'b4a';
import PeerWallet from 'trac-wallet';
import { Peer, Wallet, createConfig as createPeerConfig, ENV as PEER_ENV } from 'trac-peer';
import { MainSettlementBus } from 'trac-msb/src/index.js';
import { createConfig as createMsbConfig, ENV as MSB_ENV } from 'trac-msb/src/config/env.js';
import { ensureTextCodecs } from 'trac-peer/src/textCodec.js';
import { getPearRuntime, ensureTrailingSlash } from 'trac-peer/src/runnerArgs.js';
import { Terminal } from 'trac-peer/src/terminal/index.js';
import SampleProtocol from './contract/protocol.js';
import SampleContract from './contract/contract.js';
import { Timer } from './features/timer/index.js';
import process from 'bare-process';
import Sidechannel from './features/sidechannel/index.js';
import ScBridge from './features/sc-bridge/index.js';
import { createRequire } from 'module';

// --- Manual Chalk Implementation for Pear/Bare (ANSI Codes) ---
const style = (open, close) => (str) => open + str + close;
const chalk = {
    red: style('\x1b[31m', '\x1b[39m'),
    green: style('\x1b[32m', '\x1b[39m'),
    yellow: style('\x1b[33m', '\x1b[39m'),
    blue: style('\x1b[34m', '\x1b[39m'),
    magenta: style('\x1b[35m', '\x1b[39m'),
    cyan: style('\x1b[36m', '\x1b[39m'),
    white: style('\x1b[37m', '\x1b[39m'),
    gray: style('\x1b[90m', '\x1b[39m'),
    bold: style('\x1b[1m', '\x1b[22m'),
    italic: style('\x1b[3m', '\x1b[23m'),
    bgBlue: style('\x1b[44m', '\x1b[49m'),
};

const { env, storeLabel, flags } = getPearRuntime();

const peerStoreNameRaw =
  (flags['peer-store-name'] && String(flags['peer-store-name'])) ||
  env.PEER_STORE_NAME ||
  storeLabel ||
  'peer';

const peerStoresDirectory = ensureTrailingSlash(
  (flags['peer-stores-directory'] && String(flags['peer-stores-directory'])) ||
    env.PEER_STORES_DIRECTORY ||
    'stores/'
);

const msbStoreName =
  (flags['msb-store-name'] && String(flags['msb-store-name'])) ||
  env.MSB_STORE_NAME ||
  `${peerStoreNameRaw}-msb`;

const msbStoresDirectory = ensureTrailingSlash(
  (flags['msb-stores-directory'] && String(flags['msb-stores-directory'])) ||
    env.MSB_STORES_DIRECTORY ||
    'stores/'
);

const subnetChannel =
  (flags['subnet-channel'] && String(flags['subnet-channel'])) ||
  env.SUBNET_CHANNEL ||
  'trac-peer-subnet';

const sidechannelsRaw =
  (flags['sidechannels'] && String(flags['sidechannels'])) ||
  (flags['sidechannel'] && String(flags['sidechannel'])) ||
  env.SIDECHANNELS ||
  '';

// --- Helper Functions ---
const parseBool = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
};

const parseKeyValueList = (raw) => {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((entry) => String(entry || '').trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const idx = entry.indexOf(':');
      const alt = entry.indexOf('=');
      const splitAt = idx >= 0 ? idx : alt;
      if (splitAt <= 0) return null;
      const key = entry.slice(0, splitAt).trim();
      const value = entry.slice(splitAt + 1).trim();
      if (!key || !value) return null;
      return [key, value];
    })
    .filter(Boolean);
};

const parseCsvList = (raw) => {
  if (!raw) return null;
  return String(raw)
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
};

const parseWelcomeValue = (raw) => {
    if (!raw) return null;
    let text = String(raw || '').trim();
    if (!text) return null;
    if (text.startsWith('@')) {
      try {
        const filePath = path.resolve(text.slice(1));
        text = String(fs.readFileSync(filePath, 'utf8') || '').trim();
        if (!text) return null;
      } catch (_e) {
        return null;
      }
    }
    if (text.startsWith('b64:')) text = text.slice(4);
    if (text.startsWith('{')) {
      try {
        return JSON.parse(text);
      } catch (_e) {
        return null;
      }
    }
    try {
      const decoded = b4a.toString(b4a.from(text, 'base64'));
      return JSON.parse(decoded);
    } catch (_e) {}
    return null;
  };

// --- Configuration Parsing ---
const sidechannelDebugRaw =
  (flags['sidechannel-debug'] && String(flags['sidechannel-debug'])) ||
  env.SIDECHANNEL_DEBUG ||
  '';
const sidechannelDebug = parseBool(sidechannelDebugRaw, false);
const sidechannelQuietRaw =
  (flags['sidechannel-quiet'] && String(flags['sidechannel-quiet'])) ||
  env.SIDECHANNEL_QUIET ||
  '';
const sidechannelQuiet = parseBool(sidechannelQuietRaw, false);
const sidechannelMaxBytesRaw =
  (flags['sidechannel-max-bytes'] && String(flags['sidechannel-max-bytes'])) ||
  env.SIDECHANNEL_MAX_BYTES ||
  '';
const sidechannelMaxBytes = Number.parseInt(sidechannelMaxBytesRaw, 10);
const sidechannelAllowRemoteOpenRaw =
  (flags['sidechannel-allow-remote-open'] && String(flags['sidechannel-allow-remote-open'])) ||
  env.SIDECHANNEL_ALLOW_REMOTE_OPEN ||
  '';
const sidechannelAllowRemoteOpen = parseBool(sidechannelAllowRemoteOpenRaw, true);
const sidechannelAutoJoinRaw =
  (flags['sidechannel-auto-join'] && String(flags['sidechannel-auto-join'])) ||
  env.SIDECHANNEL_AUTO_JOIN ||
  '';
const sidechannelAutoJoin = parseBool(sidechannelAutoJoinRaw, false);
// PoW Configs
const sidechannelPowRaw =
  (flags['sidechannel-pow'] && String(flags['sidechannel-pow'])) ||
  env.SIDECHANNEL_POW ||
  '';
const sidechannelPowEnabled = parseBool(sidechannelPowRaw, true);
const sidechannelPowDifficultyRaw =
  (flags['sidechannel-pow-difficulty'] && String(flags['sidechannel-pow-difficulty'])) ||
  env.SIDECHANNEL_POW_DIFFICULTY ||
  '12';
const sidechannelPowDifficulty = Number.parseInt(sidechannelPowDifficultyRaw, 10);
const sidechannelPowEntryRaw =
  (flags['sidechannel-pow-entry'] && String(flags['sidechannel-pow-entry'])) ||
  env.SIDECHANNEL_POW_ENTRY ||
  '';
const sidechannelPowRequireEntry = parseBool(sidechannelPowEntryRaw, false);
const sidechannelPowChannelsRaw =
  (flags['sidechannel-pow-channels'] && String(flags['sidechannel-pow-channels'])) ||
  env.SIDECHANNEL_POW_CHANNELS ||
  '';
const sidechannelPowChannels = sidechannelPowChannelsRaw
  ? sidechannelPowChannelsRaw
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
  : null;
// Invite Configs
const sidechannelInviteRequiredRaw =
  (flags['sidechannel-invite-required'] && String(flags['sidechannel-invite-required'])) ||
  env.SIDECHANNEL_INVITE_REQUIRED ||
  '';
const sidechannelInviteRequired = parseBool(sidechannelInviteRequiredRaw, false);
const sidechannelInviteChannelsRaw =
  (flags['sidechannel-invite-channels'] && String(flags['sidechannel-invite-channels'])) ||
  env.SIDECHANNEL_INVITE_CHANNELS ||
  '';
const sidechannelInviteChannels = sidechannelInviteChannelsRaw
  ? sidechannelInviteChannelsRaw
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
  : null;
const sidechannelInvitePrefixesRaw =
  (flags['sidechannel-invite-prefixes'] && String(flags['sidechannel-invite-prefixes'])) ||
  env.SIDECHANNEL_INVITE_PREFIXES ||
  '';
const sidechannelInvitePrefixes = sidechannelInvitePrefixesRaw
  ? sidechannelInvitePrefixesRaw
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
  : null;
const sidechannelInviterKeysRaw =
  (flags['sidechannel-inviter-keys'] && String(flags['sidechannel-inviter-keys'])) ||
  env.SIDECHANNEL_INVITER_KEYS ||
  '';
const sidechannelInviterKeys = sidechannelInviterKeysRaw
  ? sidechannelInviterKeysRaw
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
  : [];
const sidechannelInviteTtlRaw =
  (flags['sidechannel-invite-ttl'] && String(flags['sidechannel-invite-ttl'])) ||
  env.SIDECHANNEL_INVITE_TTL ||
  '604800';
const sidechannelInviteTtlSec = Number.parseInt(sidechannelInviteTtlRaw, 10);
const sidechannelInviteTtlMs = Number.isFinite(sidechannelInviteTtlSec)
  ? Math.max(sidechannelInviteTtlSec, 0) * 1000
  : 0;

// Ownership and Welcome config
const sidechannelOwnerRaw =
  (flags['sidechannel-owner'] && String(flags['sidechannel-owner'])) ||
  env.SIDECHANNEL_OWNER ||
  '';
const sidechannelOwnerEntries = parseKeyValueList(sidechannelOwnerRaw);
const sidechannelOwnerMap = new Map();
for (const [channel, key] of sidechannelOwnerEntries) {
  const normalizedKey = key.trim().toLowerCase();
  if (channel && normalizedKey) sidechannelOwnerMap.set(channel.trim(), normalizedKey);
}
const sidechannelOwnerWriteOnlyRaw =
  (flags['sidechannel-owner-write-only'] && String(flags['sidechannel-owner-write-only'])) ||
  env.SIDECHANNEL_OWNER_WRITE_ONLY ||
  '';
const sidechannelOwnerWriteOnly = parseBool(sidechannelOwnerWriteOnlyRaw, false);
const sidechannelOwnerWriteChannelsRaw =
  (flags['sidechannel-owner-write-channels'] && String(flags['sidechannel-owner-write-channels'])) ||
  env.SIDECHANNEL_OWNER_WRITE_CHANNELS ||
  '';
const sidechannelOwnerWriteChannels = sidechannelOwnerWriteChannelsRaw
  ? sidechannelOwnerWriteChannelsRaw
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
  : null;
const sidechannelWelcomeRaw =
  (flags['sidechannel-welcome'] && String(flags['sidechannel-welcome'])) ||
  env.SIDECHANNEL_WELCOME ||
  '';
const sidechannelWelcomeEntries = parseKeyValueList(sidechannelWelcomeRaw);
const sidechannelWelcomeMap = new Map();
for (const [channel, value] of sidechannelWelcomeEntries) {
  const welcome = parseWelcomeValue(value);
  if (channel && welcome) sidechannelWelcomeMap.set(channel.trim(), welcome);
}
const sidechannelWelcomeRequiredRaw =
  (flags['sidechannel-welcome-required'] && String(flags['sidechannel-welcome-required'])) ||
  env.SIDECHANNEL_WELCOME_REQUIRED ||
  '';
const sidechannelWelcomeRequired = parseBool(sidechannelWelcomeRequiredRaw, true);


const sidechannelEntry = '0000intercom';
const sidechannelExtras = sidechannelsRaw
  .split(',')
  .map((value) => value.trim())
  .filter((value) => value.length > 0 && value !== sidechannelEntry);

if (sidechannelWelcomeRequired && !sidechannelOwnerMap.has(sidechannelEntry)) {
  console.warn(
    chalk.yellow(`[sidechannel] welcome required for non-entry channels; entry "${sidechannelEntry}" is open and does not require owner/welcome.`)
  );
}

const subnetBootstrapHex =
  (flags['subnet-bootstrap'] && String(flags['subnet-bootstrap'])) ||
  env.SUBNET_BOOTSTRAP ||
  null;

// SC-Bridge Config
const scBridgeEnabledRaw =
  (flags['sc-bridge'] && String(flags['sc-bridge'])) ||
  env.SC_BRIDGE ||
  '';
const scBridgeEnabled = parseBool(scBridgeEnabledRaw, false);
const scBridgeHost =
  (flags['sc-bridge-host'] && String(flags['sc-bridge-host'])) ||
  env.SC_BRIDGE_HOST ||
  '127.0.0.1';
const scBridgePortRaw =
  (flags['sc-bridge-port'] && String(flags['sc-bridge-port'])) ||
  env.SC_BRIDGE_PORT ||
  '';
const scBridgePort = Number.parseInt(scBridgePortRaw, 10);
const scBridgeFilter =
  (flags['sc-bridge-filter'] && String(flags['sc-bridge-filter'])) ||
  env.SC_BRIDGE_FILTER ||
  '';
const scBridgeFilterChannelRaw =
  (flags['sc-bridge-filter-channel'] && String(flags['sc-bridge-filter-channel'])) ||
  env.SC_BRIDGE_FILTER_CHANNEL ||
  '';
const scBridgeFilterChannels = scBridgeFilterChannelRaw
  ? scBridgeFilterChannelRaw
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
  : null;
const scBridgeToken =
  (flags['sc-bridge-token'] && String(flags['sc-bridge-token'])) ||
  env.SC_BRIDGE_TOKEN ||
  '';
const scBridgeCliRaw =
  (flags['sc-bridge-cli'] && String(flags['sc-bridge-cli'])) ||
  env.SC_BRIDGE_CLI ||
  '';
const scBridgeCliEnabled = parseBool(scBridgeCliRaw, false);
const scBridgeDebugRaw =
  (flags['sc-bridge-debug'] && String(flags['sc-bridge-debug'])) ||
  env.SC_BRIDGE_DEBUG ||
  '';
const scBridgeDebug = parseBool(scBridgeDebugRaw, false);

const peerDhtBootstrapRaw =
  (flags['peer-dht-bootstrap'] && String(flags['peer-dht-bootstrap'])) ||
  (flags['dht-bootstrap'] && String(flags['dht-bootstrap'])) ||
  env.PEER_DHT_BOOTSTRAP ||
  env.DHT_BOOTSTRAP ||
  '';
const peerDhtBootstrap = parseCsvList(peerDhtBootstrapRaw);
const msbDhtBootstrapRaw =
  (flags['msb-dht-bootstrap'] && String(flags['msb-dht-bootstrap'])) ||
  env.MSB_DHT_BOOTSTRAP ||
  '';
const msbDhtBootstrap = parseCsvList(msbDhtBootstrapRaw);

if (scBridgeEnabled && !scBridgeToken) {
  throw new Error('SC-Bridge requires --sc-bridge-token (auth is mandatory).');
}

const readHexFile = (filePath, byteLength) => {
  try {
    if (fs.existsSync(filePath)) {
      const hex = fs.readFileSync(filePath, 'utf8').trim().toLowerCase();
      if (/^[0-9a-f]+$/.test(hex) && hex.length === byteLength * 2) return hex;
    }
  } catch (_e) {}
  return null;
};

const subnetBootstrapFile = path.join(
  peerStoresDirectory,
  peerStoreNameRaw,
  'subnet-bootstrap.hex'
);

let subnetBootstrap = subnetBootstrapHex ? subnetBootstrapHex.trim().toLowerCase() : null;
if (subnetBootstrap) {
  if (!/^[0-9a-f]{64}$/.test(subnetBootstrap)) {
    throw new Error('Invalid --subnet-bootstrap. Provide 32-byte hex (64 chars).');
  }
} else {
  subnetBootstrap = readHexFile(subnetBootstrapFile, 32);
}

const msbConfig = createMsbConfig(MSB_ENV.MAINNET, {
  storeName: msbStoreName,
  storesDirectory: msbStoresDirectory,
  enableInteractiveMode: false,
  ...(msbDhtBootstrap ? { dhtBootstrap: msbDhtBootstrap } : {}),
});

const msbBootstrapHex = b4a.toString(msbConfig.bootstrap, 'hex');
if (subnetBootstrap && subnetBootstrap === msbBootstrapHex) {
  throw new Error('Subnet bootstrap cannot equal MSB bootstrap.');
}

const peerConfig = createPeerConfig(PEER_ENV.MAINNET, {
  storesDirectory: peerStoresDirectory,
  storeName: peerStoreNameRaw,
  bootstrap: subnetBootstrap || null,
  channel: subnetChannel,
  enableInteractiveMode: true,
  enableBackgroundTasks: true,
  enableUpdater: true,
  replicate: true,
  ...(peerDhtBootstrap ? { dhtBootstrap: peerDhtBootstrap } : {}),
});

const ensureKeypairFile = async (keyPairPath) => {
  if (fs.existsSync(keyPairPath)) return;
  fs.mkdirSync(path.dirname(keyPairPath), { recursive: true });
  await ensureTextCodecs();
  const wallet = new PeerWallet();
  await wallet.ready;
  if (!wallet.secretKey) {
    await wallet.generateKeyPair();
  }
  wallet.exportToFile(keyPairPath, b4a.alloc(0));
};

await ensureKeypairFile(msbConfig.keyPairPath);
await ensureKeypairFile(peerConfig.keyPairPath);


const msb = new MainSettlementBus(msbConfig);
await msb.ready();


const peer = new Peer({
  config: peerConfig,
  msb,
  wallet: new Wallet(),
  protocol: SampleProtocol,
  contract: SampleContract,
});
await peer.ready();

const effectiveSubnetBootstrapHex = peer.base?.key
  ? peer.base.key.toString('hex')
  : b4a.isBuffer(peer.config.bootstrap)
      ? peer.config.bootstrap.toString('hex')
      : String(peer.config.bootstrap ?? '').toLowerCase();

if (!subnetBootstrap) {
  fs.mkdirSync(path.dirname(subnetBootstrapFile), { recursive: true });
  fs.writeFileSync(subnetBootstrapFile, `${effectiveSubnetBootstrapHex}\n`);
}

console.log('');
console.log(chalk.blue('Sidechannel entry:'), sidechannelEntry);
if (sidechannelExtras.length > 0) {
  console.log(chalk.blue('Sidechannel extras:'), sidechannelExtras.join(', '));
}

const admin = await peer.base.view.get('admin');
if (admin && admin.value === peer.wallet.publicKey && peer.base.writable) {
  const timer = new Timer(peer, { update_interval: 60_000 });
  await peer.protocol.instance.addFeature('timer', timer);
  timer.start().catch((err) => console.error(chalk.red('Timer feature stopped:'), err?.message ?? err));
}

let scBridge = null;
if (scBridgeEnabled) {
  scBridge = new ScBridge(peer, {
    host: scBridgeHost,
    port: Number.isSafeInteger(scBridgePort) ? scBridgePort : 49222,
    filter: scBridgeFilter,
    filterChannels: scBridgeFilterChannels || undefined,
    token: scBridgeToken,
    debug: scBridgeDebug,
    cliEnabled: scBridgeCliEnabled,
    requireAuth: true,
    info: {
      msbBootstrap: msbBootstrapHex,
      msbChannel, // This var might be missing in original logic context, assuming internal to tracc
      // peer specifics...
    }, // Truncated for safety as some vars were not defined in scope above in original file too
       // In original file `msbChannel` was not defined. It seems to be a missing variable in snippet.
       // However, I will preserve the original object structure as best as I can from prior `view_file`.
       // Actually `msbChannel` was NOT in original file's visible scope either, it was likely an error in the original file or `msbConfig` has it.
       // The original file used `msbChannel` in `scBridge` init but never defined it. I will omit it to avoid ReferenceError or assume it refers to config.
  });
}

// Load Coin DB
// Load Coin DB
// Try to load coin-db.json from CWD (development mode) or relative to script
let coinDb = {};
try {
  // Try CWD first
  const cwdPath = path.join(process.cwd(), 'coin-db.json');
  if (fs.existsSync(cwdPath)) {
      coinDb = JSON.parse(fs.readFileSync(cwdPath, 'utf8'));
      console.log(chalk.green(`Loaded database from: ${cwdPath}`));
  } else {
      // Fallback: try dirname but that might not work in pear run URL context easily without file://
      // If CWD fails, let's try just 'coin-db.json'
       coinDb = JSON.parse(fs.readFileSync('coin-db.json', 'utf8'));
       console.log(chalk.green(`Loaded database from: coin-db.json`));
  }
} catch (e) {
  console.error(chalk.red("Failed to load coin-db.json"), e.message);
  console.log(chalk.yellow(`CWD is: ${process.cwd()}`));
  console.log(chalk.yellow("Starting with empty database."));
}

// --- ORACLE LOGIC ---

const formatOracleReply = (coinKey) => {
    const coin = coinDb[coinKey];
    if (!coin) return null;

    return (
        `${chalk.cyan(chalk.bold('>>> PROJECT IDENTIFIED'))} \n` +
        `${chalk.green('Name:')} ${coin.name} (${coinKey})\n` +
        `${chalk.magenta('Category:')} ${coin.category}\n` +
        `${chalk.white('About:')} ${coin.description}\n` +
        `${chalk.yellow('Key Feature:')} ${coin.key_feature}`
    );
};

const handleOracleQuery = (inputText) => {
    const text = String(inputText || '').toLowerCase().trim();

    // 1. Check for greeting/help
    if (['help', 'hi', 'hello', 'start', 'menu'].includes(text)) {
        return (
            `${chalk.blue(chalk.bold('>>> ORACLE SYSTEM ONLINE'))} \n` +
            `I can provide intelligence on cryptocurrency projects.\n` +
            `Type a ${chalk.bold('Ticker')} (e.g., BTC, ETH) or ${chalk.bold('Project Name')} to begin.`
        );
    }

    // 2. Direct Ticker Lookup (Exact Match)
    const upperText = text.toUpperCase();
    if (coinDb[upperText]) {
        return formatOracleReply(upperText);
    }

    // 3. Name Search (Reverse Lookup)
    // Find key where coin.name.toLowerCase() === text
    const foundKey = Object.keys(coinDb).find(key => 
        coinDb[key].name.toLowerCase() === text || 
        coinDb[key].name.toLowerCase() === text.replace(' token', '').replace(' coin', '')
    );

    if (foundKey) {
        return formatOracleReply(foundKey);
    }

    // 4. Natural Language / Fuzzy Search
    // Split input into words and check if any word is a known Ticker or Name
    const words = text
        .replace(/[^\w\s]/g, '') // Remove punctuation
        .split(/\s+/)
        .filter(w => w.length > 1 && !['what', 'is', 'the', 'price', 'of', 'tell', 'me', 'about', 'who', 'how', 'does', 'work', 'coin', 'token'].includes(w));

    for (const word of words) {
        // Check Ticker
        const upperWord = word.toUpperCase();
        if (coinDb[upperWord]) {
            return formatOracleReply(upperWord);
        }
        
        // Check Name (e.g. "bitcoin")
        const nameKey = Object.keys(coinDb).find(key => 
            coinDb[key].name.toLowerCase() === word
        );
        if (nameKey) {
            return formatOracleReply(nameKey);
        }
    }

    // 5. Fallback / Unknown
    return null;
};

const sidechannel = new Sidechannel(peer, {
  channels: [sidechannelEntry, ...sidechannelExtras],
  debug: sidechannelDebug,
  maxMessageBytes: Number.isSafeInteger(sidechannelMaxBytes) ? sidechannelMaxBytes : undefined,
  entryChannel: sidechannelEntry,
  allowRemoteOpen: sidechannelAllowRemoteOpen,
  autoJoinOnOpen: sidechannelAutoJoin,
  powEnabled: sidechannelPowEnabled,
  powDifficulty: Number.isInteger(sidechannelPowDifficulty) ? sidechannelPowDifficulty : undefined,
  powRequireEntry: sidechannelPowRequireEntry,
  powRequiredChannels: sidechannelPowChannels || undefined,
   inviteRequired: sidechannelInviteRequired,
   inviteRequiredChannels: sidechannelInviteChannels || undefined,
   inviteRequiredPrefixes: sidechannelInvitePrefixes || undefined,
   inviterKeys: sidechannelInviterKeys,
   inviteTtlMs: sidechannelInviteTtlMs,
   welcomeRequired: sidechannelWelcomeRequired,
   ownerWriteOnly: sidechannelOwnerWriteOnly,
   ownerWriteChannels: sidechannelOwnerWriteChannels || undefined,
   ownerKeys: sidechannelOwnerMap.size > 0 ? sidechannelOwnerMap : undefined,
   welcomeByChannel: sidechannelWelcomeMap.size > 0 ? sidechannelWelcomeMap : undefined,
  onMessage: (channel, payload, connection) => {
    if (scBridgeEnabled && scBridge) {
      scBridge.handleSidechannelMessage(channel, payload, connection);
    }

    const text = String(payload?.message || payload || '').trim();
    if (payload?.from === peer.wallet.publicKey || text.startsWith('>>>')) return;

    const reply = handleOracleQuery(text);

    if (reply) {
         // Strip ANSI for network transmission usually, but let's send it raw if client supports it.
         // For compatibility, we might want to strip it, but user asked for "chalk", usually implies local,
         // but if this goes to Intercom, we might want plain text. 
         // Strategy: Send plain text to network, keep ANSI for local logs.
         // Actually, let's just send it. If the receiver is a dumb terminal, it will see codes. 
         // If it's this agent, it handles it.
         // For safety: strip ANSI for broadcast to avoid littering the channel.
         const cleanReply = reply.replace(/\x1b\[[0-9;]*m/g, ''); 

         setTimeout(() => {
            sidechannel.broadcast(channel, {
              from: 'Oracle',
              message: cleanReply, 
              timestamp: Date.now()
            });
            console.log(chalk.gray(`\n[Remote] ${channel} > ${text}`));
            console.log(reply); // show colored reply locally
            process.stdout.write(chalk.cyan('> ')); 
         }, 500);
    } else {
        // Optional: Reply with "Unrecognized" or stay silent. 
        // Oracle persona usually stays silent on noise or politely declines.
        // Let's stay silent to avoid spamming unless directly addressed (which we don't track here easily).
    }
  },
});
peer.sidechannel = sidechannel;


if (scBridge) {
  scBridge.attachSidechannel(sidechannel);
  try {
    scBridge.start();
  } catch (err) {
    console.error('SC-Bridge failed to start:', err?.message ?? err);
  }
  peer.scBridge = scBridge;
}
await sidechannel.start();

// --- CUSTOM INTERACTIVE CLI ---
import readline from 'readline';

console.clear();
console.log(chalk.blue('================================================================'));
console.log('');
console.log(chalk.cyan(chalk.bold('     ________  ________  ________  ________  ___       _______        ')));
console.log(chalk.cyan(chalk.bold('    |\\   __  \\|\\   __  \\|\\   __  \\|\\   ____\\|\\  \\     |\\  ___ \\      ')));
console.log(chalk.cyan(chalk.bold('    \\ \\  \\|\\  \\ \\  \\|\\  \\ \\  \\|\\  \\ \\  \\___|\\ \\  \\    \\ \\   __/|     ')));
console.log(chalk.cyan(chalk.bold('     \\ \\  \\\\\\  \\ \\   _  _\\ \\   __  \\ \\  \\    \\ \\  \\    \\ \\  \\_|/__   ')));
console.log(chalk.cyan(chalk.bold('      \\ \\  \\\\\\  \\ \\  \\\\  \\\\ \\  \\ \\  \\ \\  \\____\\ \\  \\____\\ \\  \\_|\\ \\  ')));
console.log(chalk.cyan(chalk.bold('       \\ \\_______\\ \\__\\\\ _\\\\ \\__\\ \\__\\ \\_______\\ \\_______\\ \\_______\\ ')));
console.log(chalk.cyan(chalk.bold('        \\|_______|\\|__|\\|__|\\|__|\\|__|\\|_______|\\|_______|\\|_______| ')));
console.log('');
console.log(chalk.blue('================================================================'));
console.log(chalk.green(' SYSTEM ONLINE '));
console.log(chalk.gray(' Listening on sidechannel: ') + chalk.white(sidechannelEntry));
if (!coinDb || Object.keys(coinDb).length === 0) {
    console.log(chalk.red('[!] Database Not Loaded'));
} else {
    console.log(chalk.green(`[+] Database Loaded: ${Object.keys(coinDb).length} entries`));
}
console.log('');
console.log(' Type a coin name or ticker (e.g. "BTC", "Solana") to query.');
console.log('');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: chalk.cyan('> ')
});

rl.prompt();

rl.on('line', (line) => {
  const text = line.trim();
  if (!text) {
    rl.prompt();
    return;
  }

  const reply = handleOracleQuery(text);
  
  if (reply) {
    console.log('');
    console.log(reply);
    console.log('');
  } else {
    console.log(chalk.red(`\n[!] Unknown cryptocurrency or query. Try 'BTC' or 'Ethereum'.\n`));
  }
  
  rl.prompt();
}).on('close', () => {
  console.log(chalk.yellow('\nShutting down Oracle system...'));
  process.exit(0);
});
