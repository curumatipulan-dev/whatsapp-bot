/* Finesse WhatsApp Selfbot
   Conectare prin QR CODE afisat direct in terminal (Termux / hosting).
   Nota: patch-urile care rescriau fisiere din node_modules au fost eliminate,
   pentru ca stricau instalarea baileys si blocau conectarea. */

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, jidDecode, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const P = require('pino');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const readline = require('readline');
const qrcode = require('qrcode-terminal');

// ===================== CONFIG =====================
// Numarul tau de telefon (format international, fara + sau spatii)
const PHONE_NUMBER = '40743370530';

const PREFIXES = ['$', '=', '!'];
const SCRIPT_NAME = 'Finesse WhatsApp Selfbot';
const DATA_DIR = path.join(__dirname, 'data');
const ARHIVA_DIR = path.join(__dirname, 'arhiva');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(ARHIVA_DIR)) fs.mkdirSync(ARHIVA_DIR, { recursive: true });

const SPAM_NOTES_FILE = path.join(DATA_DIR, 'spam_notepad.txt');
const REPLY_NOTES_FILE = path.join(DATA_DIR, 'reply_notepad.txt');
const BEEF_NOTES_FILE = path.join(DATA_DIR, 'beef_notepad.txt');
const GROUP_NOTES_FILE = path.join(DATA_DIR, 'group_notepad.txt');

// ===================== UTILS =====================
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadNotepad(file) {
    try {
        const data = fs.readFileSync(file, 'utf8');
        return data.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0);
    } catch { return []; }
}

function loadLines(file) {
    try {
        const data = fs.readFileSync(file, 'utf8');
        return data.split(/\n/).map(l => l.trim()).filter(l => l.length > 0);
    } catch { return []; }
}

// ===================== STATE =====================
let spamPhrases = loadNotepad(SPAM_NOTES_FILE);
let replyWords = loadNotepad(REPLY_NOTES_FILE);
let beefPhrases = loadNotepad(BEEF_NOTES_FILE);
let groupNames = loadLines(GROUP_NOTES_FILE);

const spamState = { running: false, type: null, target: null, phraseIndex: 0, interval: null, delay: 3 };
const replyState = { running: false, targets: [], lastReplyTime: {}, replyDelays: {}, lineIndex: 0, cycle: 1 };
const aiState = { running: false, targets: [], lastReplyTime: {}, history: {}, cycle: 1 };
const customReplyState = {};
const mockTargets = {};
const mockLastTime = {};
const copyTargets = {};
const copyLastTime = {};
const autoreactActive = {};
const typingFakeIntervals = new Map();
let reverseMode = false;
let mentionTarget = null;
let afkMode = false, afkReason = '';
let afkCheckMode = false, afkCheckInterval = null, afkCheckIndex = 0;
const afkCheckPhrases = ['sup, im here pussy', 'deplasa ma iei', 'atatea suge mt?', '1,2,3 deplasa ma iei', 'ai venit sa-mi sugi?', 'stai ca vin eu la tine'];
const beeferState = { running: false, target: null, phrases: [], index: 0, interval: null, delay: 3 };
const repeatState = { running: false, target: null, text: '', interval: null };
let groupNameInterval = null, groupNameIndex = 0, groupNameTargetJid = null;

// Delay-uri mari pentru a evita ban-ul de la WhatsApp
// MINIM RECOMANDAT: spam 15s, reply 10s, beef 10s
let globalDelay = 10;   // delay repeat (secunde)
let replyDelay = 10;    // delay reply automat
let spamDelay = 15;     // delay spam - NU scade sub 10s risc ban
let channelDelay = 10;

// Delay minim absolut - sub aceste valori WhatsApp poate bana numarul
const MIN_SPAM_DELAY = 10;
const MIN_REPLY_DELAY = 5;
const MIN_BEEF_DELAY = 8;

let viewOnceCache = {};

// ===================== RECONNECT STATE =====================
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY_MS = 3000; // 3 secunde
let isReconnecting = false;

function clearAllIntervals() {
    if (spamState.interval) { clearInterval(spamState.interval); spamState.interval = null; }
    if (repeatState.interval) { clearInterval(repeatState.interval); repeatState.interval = null; }
    if (beeferState.interval) { clearInterval(beeferState.interval); beeferState.interval = null; }
    if (groupNameInterval) { clearInterval(groupNameInterval); groupNameInterval = null; }
    if (afkCheckInterval) { clearInterval(afkCheckInterval); afkCheckInterval = null; }
    for (const [, iv] of typingFakeIntervals) clearInterval(iv);
    typingFakeIntervals.clear();
}

// ===================== HELP =====================
function getHelp() {
    return `* Finesse WhatsApp Selfbot *
Prefixuri: ${PREFIXES.join(', ')}

>> COMENZI PRINCIPALE:
$reply @user  - adauga target reply (max 10)
$stopreply @user - opreste reply
$replydelay [sec] - delay global reply
$replydelay @user [sec] - delay per user

$customreply @user text - trimite text ciclic (reply->mention->simplu)
$stopcustomreply @user - opreste

$reai @user - activare AI reply (Gemini)
$stopreai @user - opreste

$start spiced @user - porneste spam user (foloseste notepad spam)
$stop spiced - opreste

$startrepeat @user text - repeta text la fiecare $delay sec
$stoprepeat - opreste

$autobeefer @user - porneste beef (foloseste notepad beef)
$stopautobeefer - opreste
$delayatbf [1-10] - delay beef

$mock @user - activeaza mock (aLtErNaTiNg)
$stopmock @user - opreste

$copymsg @user - copiaza mesajele userului
$stopcopy @user - opreste

$autoreact @user emoji - react automata la mesajele userului
$stopautoreact @user - opreste

$afk [motiv] - activeaza/dezactiveaza AFK
$afkcheck - activeaza/dezactiveaza raspuns AFK check

$reverse - inverseaza textul mesajelor tale
$stopreverse - opreste
$mention @user - adauga mention la mesajele tale
$stopmention - opreste

>> NOTEPAD:
$addnotepadspam (atasati .txt) - incarca fraze spam
$addnotepadreply (atasati .txt) - incarca fraze reply
$addnotepadbeef (atasati .txt) - incarca fraze beef
$addnotepadgroup (atasati .txt) - incarca nume pentru grup

>> GRUPURI:
$gc [id1] [id2] ... [NumeGrup] [nr] - creeaza grupuri (numerale)
$groupname - schimba numele grupului din notepad la fiecare 2.5s
$stopgroupname - opreste
$listnotepadgroup - afiseaza numele din notepad
$clearnotepadgroup - goleste notepad

>> IMAGINI:
$pic text - genereaza imagine cu text
$avatar @user - trimite poza de profil a userului
$vv - reply la o poza view-once pentru a o descarca si retrimite

>> ALTELE:
$listtargets - afiseaza toate targeturile active
$clearall - opreste toate automatizarile
$uptime - timp de functionare
$delay [sec] - delay pentru repeat
$delayspiced [sec] - delay spam
$p [nr] - sterge ultimele nr mesaje proprii (max 100)
$snipe - ultimul mesaj sters (doar in grup)
$typingfake [chatID] - simuleaza typing
$stoptypingfake [chatID/all] - opreste
$status online/idle/dnd/invisible - (doar vizual, nu are efect real in WhatsApp)
$weather [oras] - vremea (via wttr.in)
$mp3 [url] - descarca si trimite audio (necesita yt-dlp)
`;
}

// ===================== GEMINI AI =====================
const GEMINI_API_KEY = 'AQ.Ab8RN6Kscjj81am6wLrF_OpiTUEnCz1t4kfDgzOIH7Bcne9XXg'; // inlocuieste cu a ta

async function askGemini(prompt, history) {
    if (!GEMINI_API_KEY) return 'cheia Gemini lipseste';
    try {
        const historyText = history.slice(-20).map(h => `${h.role}: ${h.content}`).join('\n');
        const fullPrompt = `You are a brutally vulgar, unhinged rage machine. Rules: Respond ONLY in English, use heavy profanity, keep replies short (1-3 sentences), never be polite.\n\nConversation so far:\n${historyText}\nuser: ${prompt}\nassistent (rage):`;
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
        const response = await axios.post(url, { contents: [{ parts: [{ text: fullPrompt }] }] }, { timeout: 30000 });
        return response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 'shut the fuck up';
    } catch (err) { return `eroare AI: ${err.message.slice(0, 100)}`; }
}

// ===================== PARSE USER =====================
function parseUserFromMention(text) {
    const match = text.match(/@(\d+)/);
    if (match) return match[1] + '@s.whatsapp.net';
    if (/^\d+$/.test(text)) return text + '@s.whatsapp.net';
    return null;
}

async function getContactName(jid, sock) {
    try {
        const contact = await sock.getContact(jid);
        return contact.name || contact.notify || jid.split('@')[0];
    } catch { return jid.split('@')[0]; }
}

// ===================== MAIN BOT =====================
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth_info'));
    let version;
    try {
        const fetched = await fetchLatestBaileysVersion();
        version = fetched.version;
        console.log('[bot] Versiune WA obtinuta:', version.join('.'));
    } catch(e) {
        // fallback la versiune cunoscuta daca fetch-ul pica
        version = [2, 3000, 1015901307];
        console.log('[bot] Fetch versiune esuat, folosim fallback:', version.join('.'));
    }
    const usePairingCode = false; // folosim QR code
    const sock = makeWASocket({
        auth: state,
        version,
        logger: P({ level: 'silent' }),
        browser: ['Ubuntu', 'Chrome', '126.0.6478.127'],
        // Optiuni suplimentare pentru stabilitate
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        retryRequestDelayMs: 2000,
        maxMsgRetryCount: 5,
        markOnlineOnConnect: false, // nu marcam online la conectare, reduce riscul de ban
    });

    sock.ev.on('creds.update', saveCreds);

    // ========== PAIRING CODE (alternativa la QR) ==========
    if (usePairingCode) {
        // Asteptam ca socket-ul sa fie conectat inainte de a cere codul
        let pairingDone = false;
        const tryPairing = async () => {
            for (let attempt = 1; attempt <= 3 && !pairingDone; attempt++) {
                try {
                    await sleep(5000); // asteptam conexiunea
                    if (pairingDone) return;
                    const phone = PHONE_NUMBER.replace(/[^0-9]/g, '');
                    const code = await sock.requestPairingCode(phone);
                    pairingDone = true;
                    const formatted = code.match(/.{1,4}/g)?.join('-') || code;
                    console.log('\n------------------------------------');
                    console.log('|   COD DE ASOCIERE WHATSAPP       |');
                    console.log(`|   >>> ${formatted.padEnd(25)} <<<  |`);
                    console.log('+----------------------------------+');
                    console.log('|  1. Deschide WhatsApp             |');
                    console.log('|  2. Setari > Dispozitive conectate|');
                    console.log('|  3. Asociaza cu nr de telefon     |');
                    console.log('|  4. Introdu codul de mai sus      |');
                    console.log('|  *** Codul expira in ~60 secunde  |');
                    console.log('------------------------------------\n');
                    // Afisam codul din nou dupa 30s in caz ca nu l-au vazut
                    setTimeout(() => {
                        if (!pairingDone) return;
                        console.log(`[pairing] Reminder cod: ${formatted} (daca nu l-ai introdus inca)`);
                    }, 30000);
                } catch (err) {
                    console.error(`[pairing] Tentativa ${attempt}/3 esuata:`, err.message);
                    if (attempt < 3) console.log('[pairing] Reincercam...');
                    else console.log('[pairing] Sterge auth_info si restarteaza botul.');
                }
            }
        };
        tryPairing();
    }

    // ========== HANDLER UNIC connection.update ==========
    // IMPORTANT: un singur handler, nu doua!
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n================ SCANEAZA QR ================');
            console.log('WhatsApp > Setari > Dispozitive conectate > Asociaza un dispozitiv');
            console.log('=============================================\n');
            // QR direct in terminal (Termux). small:true incape pe ecran de telefon.
            qrcode.generate(qr, { small: true });
            const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' + encodeURIComponent(qr);
            console.log('\nDaca QR-ul din terminal e taiat, deschide acest link pe alt ecran:');
            console.log(qrUrl + '\n');
        }

        if (connection === 'close') {
            // Curatam toate intervalele la disconnect
            clearAllIntervals();

            // FIX CRITIC: parantezele corecte pentru a extrage statusCode din eroarea Boom
            // Inainte era: (lastDisconnect?.error instanceof Boom)?.output?.statusCode
            // asta returna undefined mereu pentru ca instanceof returneaza boolean
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            const reason = lastDisconnect?.error?.message || 'necunoscut';

            console.log(`[X] Conexiune inchisa. Cod: ${statusCode}, Motiv: ${reason}`);

            // Cazuri in care NU reconectam (ar pica definitiv numarul)
            if (statusCode === DisconnectReason.loggedOut) {
                console.log('[STOP] Cont delogat. Sterg auth_info automat si restarteaza...');
                try {
                    const authDir = path.join(__dirname, 'auth_info');
                    if (fs.existsSync(authDir)) {
                        fs.rmSync(authDir, { recursive: true, force: true });
                        console.log('[bot] auth_info sters. Restarteaza botul manual.');
                    }
                } catch(e) { console.error('[bot] Nu am putut sterge auth_info:', e.message); }
                process.exit(1);
                return;
            }

            if (statusCode === DisconnectReason.banned) {
                console.log('[BAN] Contul a fost banat de WhatsApp. Nu reconectam.');
                process.exit(1);
                return;
            }

            // 515 / restartRequired: NORMAL imediat dupa scanarea QR-ului.
            // NU stergem auth_info aici (bug vechi: stergea sesiunea si cerea QR la infinit).
            if (statusCode === DisconnectReason.restartRequired || statusCode === 515) {
                console.log('[->] Restart cerut de WhatsApp (normal dupa scanare QR). Reconectam...');
                reconnectAttempts = 0;
                isReconnecting = false;
                setTimeout(() => startBot(), 2000);
                return;
            }

            // 500 = sesiune invalida -> stergem auth si repornim curat (cerem QR nou)
            if (statusCode === 500) {
                console.log('[500] Sesiune invalida. Sterg auth_info si cer QR nou...');
                try {
                    const authDir = path.join(__dirname, 'auth_info');
                    if (fs.existsSync(authDir)) {
                        fs.rmSync(authDir, { recursive: true, force: true });
                        console.log('[bot] auth_info sters automat.');
                    }
                } catch(e) { console.error('[bot] Nu am putut sterge auth_info:', e.message); }
                isReconnecting = false;
                setTimeout(() => startBot(), 5000);
                return;
            }

            // Verificam numarul maxim de reconectari
            if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
                console.log(`[STOP] ${MAX_RECONNECT_ATTEMPTS} reconectari esuate. Oprire pentru a nu pica numarul. Restarteaza manual.`);
                process.exit(1);
                return;
            }

            // Evitam reconectari multiple simultane
            if (isReconnecting) {
                console.log('>> Reconectare deja in curs...');
                return;
            }

            isReconnecting = true;
            reconnectAttempts++;

            // Backoff exponential: 3s, 6s, 12s, 24s... pana la maxim 60s
            // Asta previne rate-limiting si ban de la WhatsApp
            const delay = Math.min(BASE_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts - 1), 60000);
            console.log(`>> Reconectare incercare ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay / 1000}s...`);

            await sleep(delay);
            isReconnecting = false;

            // Cazuri speciale care necesita reconectare imediata/normala
            if (statusCode === DisconnectReason.restartRequired) {
                console.log('[->] Restart cerut de server, reconectam...');
                reconnectAttempts = 0; // restartRequired nu e o eroare, resetam contorul
            }

            startBot();

        } else if (connection === 'open') {
            // Conectat cu succes - resetam contorul de erori
            reconnectAttempts = 0;
            isReconnecting = false;
            console.log(`[OK] ${SCRIPT_NAME} conectat!`);
            console.log(`Fraze spam: ${spamPhrases.length} | reply: ${replyWords.length} | beef: ${beefPhrases.length}`);
        } else if (connection === 'connecting') {
            console.log('[~] Conectare la WhatsApp...');
        }
    });

    let startTime = Date.now();

    function uptime() {
        const s = Math.floor((Date.now() - startTime) / 1000);
        const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
        return `${d}z ${h}h ${m}m ${sec}s`;
    }

    // ========== PROCESARE MESAJE ==========
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message) return;

        // ====== SALVARE VIEW-ONCE ======
        if (msg.message?.viewOnceMessage) {
            const viewOnceMsg = msg.message.viewOnceMessage;
            const parentMsg = viewOnceMsg.message || viewOnceMsg;
            const key = msg.key.id;
            viewOnceCache[key] = {
                jid: msg.key.remoteJid,
                fromMe: msg.key.fromMe,
                viewOnceMsg: viewOnceMsg,
                parentMsg: parentMsg,
                timestamp: Date.now()
            };
            // retinem doar ultimele 50
            const keys = Object.keys(viewOnceCache);
            if (keys.length > 50) {
                const sorted = keys.sort((a, b) => viewOnceCache[a].timestamp - viewOnceCache[b].timestamp);
                delete viewOnceCache[sorted[0]];
            }
        }

        // ====== COMENZI TRIMISE DE MINE ======
        if (msg.key.fromMe && msg.message?.conversation) {
            const text = msg.message.conversation;
            if (!text) return;

            let prefix = null;
            for (const p of PREFIXES) {
                if (text.startsWith(p)) { prefix = p; break; }
            }
            if (!prefix) return;

            const args = text.slice(prefix.length).trim().split(/\s+/);
            const cmd = args.shift().toLowerCase();

            await handleCommand(sock, msg, cmd, args);
            return;
        }

        // ====== AUTO-RESPONSES LA MESAJELE ALTORA ======
        if (!msg.key.fromMe && msg.message?.conversation) {
            const sender = msg.key.remoteJid;
            const content = msg.message.conversation;
            const now = Date.now();

            // autoreact
            if (autoreactActive[sender]) {
                try {
                    await sock.sendMessage(sender, { react: { text: autoreactActive[sender], key: msg.key } });
                } catch {}
            }

            // AFK
            if (afkMode && content.includes('@' + sock.user?.id?.split('@')[0])) {
                const replies = [`sefu doarme iti scrie el mai tarziu (${afkReason || 'AFK'})`, `sefu e in vacanta iti raspunde el mai tarziu (${afkReason || 'AFK'})`];
                await sock.sendMessage(sender, { text: replies[Math.floor(Math.random() * replies.length)] }).catch(() => {});
            }

            // AFK check
            if (afkCheckMode && content.toLowerCase().includes('afkcheck') && content.includes('@' + sock.user?.id?.split('@')[0])) {
                if (afkCheckInterval) clearInterval(afkCheckInterval);
                afkCheckIndex = 0;
                afkCheckInterval = setInterval(async () => {
                    if (!afkCheckMode) { clearInterval(afkCheckInterval); afkCheckInterval = null; return; }
                    const phrase = afkCheckPhrases[afkCheckIndex++ % afkCheckPhrases.length];
                    await sock.sendMessage(sender, { text: phrase }).catch(() => {});
                }, 3000);
            }

            // CUSTOM REPLY
            if (customReplyState[sender]) {
                const state = customReplyState[sender];
                const text = state.text;
                if (!text) return;
                const cycle = state.cycle || 1;
                try {
                    if (cycle === 1) {
                        await sock.sendMessage(sender, { text: text, mentions: [sender] });
                    } else if (cycle === 2) {
                        await sock.sendMessage(sender, { text: `@${sender.split('@')[0]} ${text}`, mentions: [sender] });
                    } else {
                        await sock.sendMessage(sender, { text: text });
                    }
                } catch {}
                state.cycle = (cycle % 3) + 1;
                return;
            }

            // MOCK
            if (mockTargets[sender] && content.trim()) {
                const last = mockLastTime[sender] || 0;
                if (now - last >= 1500) {
                    mockLastTime[sender] = now;
                    const mocked = content.split('').map((c, i) => i % 2 === 0 ? c.toLowerCase() : c.toUpperCase()).join('');
                    await sock.sendMessage(sender, { text: mocked, mentions: [sender] }).catch(() => {});
                }
                return;
            }

            // COPYMSG
            if (copyTargets[sender] && content.trim()) {
                const last = copyLastTime[sender] || 0;
                if (now - last >= 1500) {
                    copyLastTime[sender] = now;
                    await sock.sendMessage(sender, { text: content, mentions: [sender] }).catch(() => {});
                }
                return;
            }

            // REPLY
            if (replyState.running && replyState.targets.includes(sender)) {
                const last = replyState.lastReplyTime[sender] || 0;
                if (now - last < 1500) return;
                replyState.lastReplyTime[sender] = now;
                const effDelay = replyState.replyDelays[sender] !== undefined ? replyState.replyDelays[sender] : replyDelay;
                await sleep(effDelay * 1000);
                if (!replyState.running || !replyState.targets.includes(sender)) return;
                if (!replyWords.length) return;
                if (replyState.lineIndex >= replyWords.length) replyState.lineIndex = 0;
                const line = replyWords[replyState.lineIndex++];
                if (!line) return;
                try {
                    if (replyState.cycle === 1) {
                        await sock.sendMessage(sender, { text: line, mentions: [sender] });
                    } else if (replyState.cycle === 2) {
                        await sock.sendMessage(sender, { text: `@${sender.split('@')[0]} ${line}`, mentions: [sender] });
                    } else {
                        await sock.sendMessage(sender, { text: line });
                    }
                } catch {}
                replyState.cycle = (replyState.cycle % 3) + 1;
                return;
            }

            // AI REPLY
            if (aiState.running && aiState.targets.includes(sender)) {
                const last = aiState.lastReplyTime[sender] || 0;
                if (now - last < 1500) return;
                aiState.lastReplyTime[sender] = now;
                await sleep(replyDelay * 1000);
                if (!aiState.running) return;
                if (!aiState.history[sender]) aiState.history[sender] = [];
                aiState.history[sender].push({ role: 'user', content: content });
                if (aiState.history[sender].length > 20) aiState.history[sender].shift();
                const reply = await askGemini(content, aiState.history[sender]);
                aiState.history[sender].push({ role: 'assistant', content: reply });
                if (!reply) return;
                try {
                    if (aiState.cycle === 1) {
                        await sock.sendMessage(sender, { text: reply, mentions: [sender] });
                    } else if (aiState.cycle === 2) {
                        await sock.sendMessage(sender, { text: `@${sender.split('@')[0]} ${reply}`, mentions: [sender] });
                    } else {
                        await sock.sendMessage(sender, { text: reply });
                    }
                } catch {}
                aiState.cycle = (aiState.cycle % 3) + 1;
                return;
            }

            // BEEFER
            if (beeferState.running && beeferState.target === sender) {
                // se face prin interval
            }
        }

        // ====== view-once: procesare reply la .vv ======
        if (msg.key.fromMe && msg.message?.conversation && msg.message.conversation.trim() === '.vv') {
            const repliedId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
            if (repliedId && viewOnceCache[repliedId]) {
                const cached = viewOnceCache[repliedId];
                try {
                    const media = await downloadMediaMessage(
                        { key: { id: repliedId, remoteJid: cached.jid }, message: cached.parentMsg },
                        'buffer',
                        {},
                        { reuploadRequest: sock.updateMediaMessage }
                    );
                    if (media) {
                        await sock.sendMessage(msg.key.remoteJid, { image: media, caption: '[IMG] View-once descarcat!' });
                    } else {
                        await sock.sendMessage(msg.key.remoteJid, { text: '[X] Nu am putut descarca media.' });
                    }
                } catch (err) {
                    await sock.sendMessage(msg.key.remoteJid, { text: `[X] Eroare: ${err.message}` });
                }
                delete viewOnceCache[repliedId];
                return;
            } else {
                await sock.sendMessage(msg.key.remoteJid, { text: '[X] Nu am gasit niciun view-once la care sa raspunzi.' });
                return;
            }
        }
    });

    // ========== FUNCTIA DE PROCESARE COMENZI ==========
    async function handleCommand(sock, msg, cmd, args) {
        const chatId = msg.key.remoteJid;

        if (cmd === 'help' || cmd === 'list') {
            await sock.sendMessage(chatId, { text: getHelp() });
            return;
        }

        // -------- COMENZI GENERALE --------
        if (cmd === 'uptime') {
            await sock.sendMessage(chatId, { text: `[TIME] Uptime: ${uptime()}` });
            return;
        }

        if (cmd === 'delay') {
            if (!args.length || isNaN(parseFloat(args[0]))) {
                await sock.sendMessage(chatId, { text: '$delay [secunde]' });
                return;
            }
            globalDelay = parseFloat(args[0]);
            await sock.sendMessage(chatId, { text: `[OK] Delay repeat setat la ${globalDelay}s` });
            return;
        }

        if (cmd === 'delayspiced') {
            if (!args.length || isNaN(parseInt(args[0]))) {
                await sock.sendMessage(chatId, { text: `$delayspiced [sec] | minim recomandat: ${MIN_SPAM_DELAY}s | curent: ${spamDelay}s` });
                return;
            }
            const val = parseInt(args[0]);
            if (val < MIN_SPAM_DELAY) {
                await sock.sendMessage(chatId, { text: `[!] Minim ${MIN_SPAM_DELAY}s pentru spam! Sub aceasta valoare risc ban WhatsApp. Folosit ${MIN_SPAM_DELAY}s.` });
                spamDelay = MIN_SPAM_DELAY;
            } else if (val > 300) {
                await sock.sendMessage(chatId, { text: '$delayspiced [10-300]' });
                return;
            } else {
                spamDelay = val;
            }
            await sock.sendMessage(chatId, { text: `[OK] Delay spam setat la ${spamDelay}s` });
            return;
        }

        // -------- STATUS (doar vizual) --------
        if (cmd === 'status') {
            const st = args[0]?.toLowerCase();
            const valid = ['online', 'idle', 'dnd', 'invisible'];
            if (!st || !valid.includes(st)) {
                await sock.sendMessage(chatId, { text: `Status disponibile: ${valid.join(', ')}` });
                return;
            }
            await sock.sendMessage(chatId, { text: `* Status setat (vizual) la ${st}` });
            return;
        }

        // -------- WEATHER --------
        if (cmd === 'weather') {
            if (!args.length) {
                await sock.sendMessage(chatId, { text: '$weather [oras]' });
                return;
            }
            const location = args.join(' ');
            try {
                const r = await axios.get(`https://wttr.in/${encodeURIComponent(location)}?format=j1`, { timeout: 10000 });
                const d = r.data;
                const current = d.current_condition?.[0];
                if (!current) { await sock.sendMessage(chatId, { text: 'Locatie negasita' }); return; }
                const temp = current.temp_C;
                const feels = current.FeelsLikeC;
                const desc = current.weatherDesc?.[0]?.value || '';
                const humidity = current.humidity;
                const wind = current.windspeedKmph;
                const nearest = d.nearest_area?.[0];
                const city = nearest?.areaName?.[0]?.value || location;
                const country = nearest?.country?.[0]?.value || '';
                await sock.sendMessage(chatId, {
                    text: `**${city}${country ? ', ' + country : ''}** - ${desc}\n${temp} gradeC (simte ca ${feels} gradeC) | Umiditate: ${humidity}% | Vant: ${wind} km/h`
                });
            } catch (err) {
                await sock.sendMessage(chatId, { text: `Eroare: ${err.message}` });
            }
            return;
        }

        // -------- PIC (genereaza imagine cu text) --------
        if (cmd === 'pic') {
            if (!args.length) {
                await sock.sendMessage(chatId, { text: '$pic [text]' });
                return;
            }
            const customText = args.join(' ');
            try {
                const { createCanvas } = require('canvas');
                const canvas = createCanvas(800, 400);
                const ctx = canvas.getContext('2d');
                const gradient = ctx.createLinearGradient(0, 0, 800, 400);
                gradient.addColorStop(0, '#1a1a2e');
                gradient.addColorStop(1, '#16213e');
                ctx.fillStyle = gradient;
                ctx.fillRect(0, 0, 800, 400);
                ctx.strokeStyle = '#a78bfa';
                ctx.lineWidth = 4;
                ctx.strokeRect(10, 10, 780, 380);
                ctx.fillStyle = '#f0f0ff';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                let text = customText.slice(0, 200);
                const maxCharsPerLine = 30;
                let lines = [];
                let currentLine = '';
                for (let ch of text) {
                    if (currentLine.length >= maxCharsPerLine && ch === ' ') {
                        lines.push(currentLine);
                        currentLine = '';
                    } else {
                        currentLine += ch;
                    }
                }
                if (currentLine) lines.push(currentLine);
                const lineHeight = 56;
                const totalHeight = lines.length * lineHeight;
                const startY = (400 - totalHeight) / 2 + lineHeight / 2;
                ctx.font = 'bold 46px "Segoe UI", Arial, sans-serif';
                lines.forEach((line, i) => {
                    ctx.fillText(line, 400, startY + i * lineHeight);
                });
                const buffer = canvas.toBuffer('image/png');
                await sock.sendMessage(chatId, { image: buffer, caption: '[IMG] Imagine generata' });
            } catch (err) {
                await sock.sendMessage(chatId, { text: `Eroare generare imagine: ${err.message}` });
            }
            return;
        }

        // -------- AVATAR (poza de profil) --------
        if (cmd === 'avatar') {
            let jid = chatId;
            if (args.length) {
                const parsed = parseUserFromMention(args[0]);
                if (parsed) jid = parsed;
            }
            try {
                const pp = await sock.profilePictureUrl(jid, 'image');
                await sock.sendMessage(chatId, { image: { url: pp }, caption: `Avatar pentru ${jid.split('@')[0]}` });
            } catch {
                await sock.sendMessage(chatId, { text: 'Nu am putut obtine poza de profil.' });
            }
            return;
        }

        // -------- SNIPE --------
        if (cmd === 'snipe') {
            await sock.sendMessage(chatId, { text: '[X] Functia snipe nu este disponibila in WhatsApp.' });
            return;
        }

        // -------- P (sterge mesaje proprii) --------
        if (cmd === 'p') {
            if (!args.length || isNaN(parseInt(args[0])) || parseInt(args[0]) < 1) {
                await sock.sendMessage(chatId, { text: '$p [nr] (1-100)' });
                return;
            }
            const count = Math.min(parseInt(args[0]), 100);
            await sock.sendMessage(chatId, { text: `[X] Nu pot sterge mesaje in WhatsApp.` });
            return;
        }

        // -------- AFK --------
        if (cmd === 'afk') {
            afkMode = !afkMode;
            afkReason = args.join(' ') || '';
            await sock.sendMessage(chatId, { text: `AFK ${afkMode ? 'activat' : 'dezactivat'}${afkReason ? ` (${afkReason})` : ''}` });
            return;
        }
        if (cmd === 'afkcheck') {
            afkCheckMode = !afkCheckMode;
            if (!afkCheckMode && afkCheckInterval) { clearInterval(afkCheckInterval); afkCheckInterval = null; }
            await sock.sendMessage(chatId, { text: `AFK Check ${afkCheckMode ? 'activat' : 'dezactivat'}` });
            return;
        }

        // -------- REVERSE / MENTION --------
        if (cmd === 'reverse') {
            reverseMode = !reverseMode;
            await sock.sendMessage(chatId, { text: `Reverse ${reverseMode ? 'activat' : 'dezactivat'}` });
            return;
        }
        if (cmd === 'stopreverse') {
            reverseMode = false;
            await sock.sendMessage(chatId, { text: 'Reverse dezactivat' });
            return;
        }
        if (cmd === 'mention') {
            if (!args.length) {
                await sock.sendMessage(chatId, { text: `Mention target: ${mentionTarget || 'niciunul'}` });
                return;
            }
            const parsed = parseUserFromMention(args[0]);
            if (!parsed) { await sock.sendMessage(chatId, { text: 'User invalid' }); return; }
            mentionTarget = parsed;
            await sock.sendMessage(chatId, { text: `Mention activat: ${parsed.split('@')[0]}` });
            return;
        }
        if (cmd === 'stopmention') {
            mentionTarget = null;
            await sock.sendMessage(chatId, { text: 'Mention dezactivat' });
            return;
        }

        // -------- REPLY / STOPREPLY --------
        if (cmd === 'reply') {
            if (!args.length) {
                await sock.sendMessage(chatId, { text: '$reply @user' });
                return;
            }
            const jid = parseUserFromMention(args[0]);
            if (!jid) { await sock.sendMessage(chatId, { text: 'User invalid' }); return; }
            if (replyState.targets.includes(jid)) {
                await sock.sendMessage(chatId, { text: 'Deja in lista reply' });
                return;
            }
            if (replyState.targets.length >= 10) {
                await sock.sendMessage(chatId, { text: 'Limita de 10 targeti atinsa' });
                return;
            }
            replyState.running = true;
            replyState.targets.push(jid);
            await sock.sendMessage(chatId, { text: `Reply adaugat: ${jid.split('@')[0]} (${replyState.targets.length}/10)` });
            return;
        }
        if (cmd === 'stopreply') {
            if (!args.length) {
                replyState.running = false;
                replyState.targets = [];
                replyState.lastReplyTime = {};
                await sock.sendMessage(chatId, { text: 'Reply oprit pentru toti' });
                return;
            }
            const jid = parseUserFromMention(args[0]);
            if (!jid) { await sock.sendMessage(chatId, { text: 'User invalid' }); return; }
            const idx = replyState.targets.indexOf(jid);
            if (idx === -1) { await sock.sendMessage(chatId, { text: 'Nu e in lista' }); return; }
            replyState.targets.splice(idx, 1);
            delete replyState.lastReplyTime[jid];
            delete replyState.replyDelays[jid];
            if (replyState.targets.length === 0) replyState.running = false;
            await sock.sendMessage(chatId, { text: `Reply oprit pentru ${jid.split('@')[0]} (${replyState.targets.length} ramasi)` });
            return;
        }
        if (cmd === 'replydelay') {
            if (!args.length) {
                await sock.sendMessage(chatId, { text: `$replydelay [sec] sau $replydelay @user [sec] | minim recomandat: ${MIN_REPLY_DELAY}s | curent: ${replyDelay}s` });
                return;
            }
            if (args.length >= 2 && /^\d+$/.test(args[1])) {
                const jid = parseUserFromMention(args[0]);
                if (jid) {
                    const val = Math.max(parseInt(args[1]), MIN_REPLY_DELAY);
                    replyState.replyDelays[jid] = val;
                    await sock.sendMessage(chatId, { text: `Delay reply pentru ${jid.split('@')[0]}: ${val}s${val > parseInt(args[1]) ? ` (ridicat la minim ${MIN_REPLY_DELAY}s)` : ''}` });
                    return;
                }
            }
            if (!/^\d+$/.test(args[0])) {
                await sock.sendMessage(chatId, { text: '$replydelay [sec]' });
                return;
            }
            const val = Math.max(parseInt(args[0]), MIN_REPLY_DELAY);
            replyDelay = val;
            await sock.sendMessage(chatId, { text: `Delay reply global: ${replyDelay}s${val > parseInt(args[0]) ? ` (ridicat la minim ${MIN_REPLY_DELAY}s)` : ''}` });
            return;
        }

        // -------- CUSTOMREPLY / STOPCUSTOMREPLY / LISTCUSTOMREPLY --------
        if (cmd === 'customreply' || cmd === 'customspam') {
            if (args.length < 2) {
                await sock.sendMessage(chatId, { text: '$customreply @user text' });
                return;
            }
            const jid = parseUserFromMention(args[0]);
            if (!jid) { await sock.sendMessage(chatId, { text: 'User invalid' }); return; }
            const text = args.slice(1).join(' ');
            customReplyState[jid] = { text, cycle: 1 };
            await sock.sendMessage(chatId, { text: `Customreply activat pentru ${jid.split('@')[0]}: ${text.slice(0, 50)}...` });
            return;
        }
        if (cmd === 'stopcustomreply' || cmd === 'stopcustomspam') {
            if (!args.length) {
                await sock.sendMessage(chatId, { text: '$stopcustomreply @user' });
                return;
            }
            const jid = parseUserFromMention(args[0]);
            if (!jid) { await sock.sendMessage(chatId, { text: 'User invalid' }); return; }
            if (!customReplyState[jid]) {
                await sock.sendMessage(chatId, { text: 'Nu este activ pentru acest user' });
                return;
            }
            delete customReplyState[jid];
            await sock.sendMessage(chatId, { text: `Customreply oprit pentru ${jid.split('@')[0]}` });
            return;
        }
        if (cmd === 'listcustomreply' || cmd === 'listcustomspam') {
            const keys = Object.keys(customReplyState);
            if (!keys.length) { await sock.sendMessage(chatId, { text: 'Niciun customreply activ' }); return; }
            const lines = keys.map(j => `${j.split('@')[0]}: ${customReplyState[j].text.slice(0, 60)}`);
            await sock.sendMessage(chatId, { text: 'CUSTOMREPLY ACTIV:\n' + lines.join('\n') });
            return;
        }

        // -------- REAI / STOPREAI --------
        if (cmd === 'reai') {
            if (!args.length) {
                await sock.sendMessage(chatId, { text: '$reai @user' });
                return;
            }
            const jid = parseUserFromMention(args[0]);
            if (!jid) { await sock.sendMessage(chatId, { text: 'User invalid' }); return; }
            if (aiState.targets.includes(jid)) {
                await sock.sendMessage(chatId, { text: 'Deja in lista AI' });
                return;
            }
            if (aiState.targets.length >= 10) {
                await sock.sendMessage(chatId, { text: 'Limita de 10 targeti' });
                return;
            }
            aiState.running = true;
            aiState.targets.push(jid);
            if (!aiState.history[jid]) aiState.history[jid] = [];
            await sock.sendMessage(chatId, { text: `AI reply activat: ${jid.split('@')[0]} (${aiState.targets.length}/10)` });
            return;
        }
        if (cmd === 'stopreai') {
            if (!args.length) {
                aiState.running = false;
                aiState.targets = [];
                aiState.history = {};
                await sock.sendMessage(chatId, { text: 'AI reply oprit pentru toti' });
                return;
            }
            const jid = parseUserFromMention(args[0]);
            if (!jid) { await sock.sendMessage(chatId, { text: 'User invalid' }); return; }
            const idx = aiState.targets.indexOf(jid);
            if (idx === -1) { await sock.sendMessage(chatId, { text: 'Nu e in lista' }); return; }
            aiState.targets.splice(idx, 1);
            delete aiState.history[jid];
            delete aiState.lastReplyTime[jid];
            if (aiState.targets.length === 0) aiState.running = false;
            await sock.sendMessage(chatId, { text: `AI reply oprit pentru ${jid.split('@')[0]}` });
            return;
        }

        // -------- START SPICED / STOP SPICED --------
        if (cmd === 'start' && args[0] === 'spiced') {
            if (args.length < 2) {
                await sock.sendMessage(chatId, { text: '$start spiced @user' });
                return;
            }
            const jid = parseUserFromMention(args[1]);
            if (!jid) { await sock.sendMessage(chatId, { text: 'User invalid' }); return; }
            if (spamState.running) {
                await sock.sendMessage(chatId, { text: 'Spam deja activ' });
                return;
            }
            if (!spamPhrases.length) {
                await sock.sendMessage(chatId, { text: 'Notepad spam gol, foloseste $addnotepadspam' });
                return;
            }
            spamState.running = true;
            spamState.type = 'spiced';
            spamState.target = jid;
            spamState.phraseIndex = 0;
            if (spamState.interval) clearInterval(spamState.interval);
            spamState.interval = setInterval(async () => {
                if (!spamState.running) { clearInterval(spamState.interval); spamState.interval = null; return; }
                if (spamState.phraseIndex >= spamPhrases.length) spamState.phraseIndex = 0;
                const p = spamPhrases[spamState.phraseIndex++];
                if (p?.trim()) {
                    await sock.sendMessage(chatId, { text: `@${jid.split('@')[0]}\n${p}`, mentions: [jid] }).catch(() => {});
                }
            }, spamDelay * 1000);
            await sock.sendMessage(chatId, { text: `Spam pornit pentru ${jid.split('@')[0]} (delay ${spamDelay}s)` });
            return;
        }
        if (cmd === 'stop' && args[0] === 'spiced') {
            if (!spamState.running) {
                await sock.sendMessage(chatId, { text: 'Spam nu ruleaza' });
                return;
            }
            spamState.running = false;
            spamState.type = null;
            spamState.target = null;
            spamState.phraseIndex = 0;
            if (spamState.interval) { clearInterval(spamState.interval); spamState.interval = null; }
            await sock.sendMessage(chatId, { text: 'Spam oprit' });
            return;
        }

        // -------- STARTREPEAT / STOPREPEAT --------
        if (cmd === 'startrepeat') {
            if (args.length < 2) {
                await sock.sendMessage(chatId, { text: '$startrepeat @user text' });
                return;
            }
            const jid = parseUserFromMention(args[0]);
            if (!jid) { await sock.sendMessage(chatId, { text: 'User invalid' }); return; }
            const text = args.slice(1).join(' ');
            if (!text.trim()) { await sock.sendMessage(chatId, { text: 'Textul nu poate fi gol' }); return; }
            if (repeatState.running) {
                await sock.sendMessage(chatId, { text: 'Repeat deja activ' });
                return;
            }
            repeatState.running = true;
            repeatState.target = jid;
            repeatState.text = text;
            if (repeatState.interval) clearInterval(repeatState.interval);
            repeatState.interval = setInterval(async () => {
                if (!repeatState.running) { clearInterval(repeatState.interval); repeatState.interval = null; return; }
                if (repeatState.text?.trim()) {
                    await sock.sendMessage(chatId, { text: `@${repeatState.target.split('@')[0]} ${repeatState.text}`, mentions: [repeatState.target] }).catch(() => {});
                }
            }, globalDelay * 1000);
            await sock.sendMessage(chatId, { text: `Repeat pornit pentru ${jid.split('@')[0]} (delay ${globalDelay}s)` });
            return;
        }
        if (cmd === 'stoprepeat') {
            if (!repeatState.running) {
                await sock.sendMessage(chatId, { text: 'Repeat nu e activ' });
                return;
            }
            repeatState.running = false;
            repeatState.target = null;
            repeatState.text = '';
            if (repeatState.interval) { clearInterval(repeatState.interval); repeatState.interval = null; }
            await sock.sendMessage(chatId, { text: 'Repeat oprit' });
            return;
        }

        // -------- AUTOBEEFER / STOPAUTOBEEFER / DELAYATBF --------
        if (cmd === 'autobeefer') {
            if (!args.length) {
                await sock.sendMessage(chatId, { text: '$autobeefer @user' });
                return;
            }
            const jid = parseUserFromMention(args[0]);
            if (!jid) { await sock.sendMessage(chatId, { text: 'User invalid' }); return; }
            if (beeferState.running) {
                await sock.sendMessage(chatId, { text: 'Autobeefer deja activ' });
                return;
            }
            if (!beefPhrases.length) {
                await sock.sendMessage(chatId, { text: 'Notepad beef gol, foloseste $addnotepadbeef' });
                return;
            }
            beeferState.running = true;
            beeferState.target = jid;
            beeferState.index = 0;
            if (beeferState.interval) clearInterval(beeferState.interval);
            beeferState.interval = setInterval(async () => {
                if (!beeferState.running) { clearInterval(beeferState.interval); beeferState.interval = null; return; }
                if (beeferState.index >= beefPhrases.length) beeferState.index = 0;
                const phrase = beefPhrases[beeferState.index++];
                if (phrase?.trim()) {
                    await sock.sendMessage(chatId, { text: `@${beeferState.target.split('@')[0]} ${phrase}`, mentions: [beeferState.target] }).catch(() => {});
                }
            }, beeferState.delay * 1000);
            await sock.sendMessage(chatId, { text: `Autobeefer pornit pentru ${jid.split('@')[0]} (delay ${beeferState.delay}s)` });
            return;
        }
        if (cmd === 'stopautobeefer') {
            if (!beeferState.running) {
                await sock.sendMessage(chatId, { text: 'Autobeefer nu ruleaza' });
                return;
            }
            beeferState.running = false;
            beeferState.target = null;
            beeferState.index = 0;
            if (beeferState.interval) { clearInterval(beeferState.interval); beeferState.interval = null; }
            await sock.sendMessage(chatId, { text: 'Autobeefer oprit' });
            return;
        }
        if (cmd === 'delayatbf') {
            if (!args.length || isNaN(parseFloat(args[0]))) {
                await sock.sendMessage(chatId, { text: `Delay curent beef: ${beeferState.delay || MIN_BEEF_DELAY}s | minim recomandat: ${MIN_BEEF_DELAY}s` });
                return;
            }
            const val = parseFloat(args[0]);
            if (val < MIN_BEEF_DELAY) {
                await sock.sendMessage(chatId, { text: `[!] Minim ${MIN_BEEF_DELAY}s pentru beef! Setat la ${MIN_BEEF_DELAY}s.` });
                beeferState.delay = MIN_BEEF_DELAY;
            } else if (val > 300) {
                await sock.sendMessage(chatId, { text: `$delayatbf [${MIN_BEEF_DELAY}-300]` });
                return;
            } else {
                beeferState.delay = val;
            }
            await sock.sendMessage(chatId, { text: `Delay autobeefer setat la ${beeferState.delay}s` });
            return;
        }

        // -------- MOCK / STOPMOCK --------
        if (cmd === 'mock') {
            if (!args.length) {
                await sock.sendMessage(chatId, { text: '$mock @user' });
                return;
            }
            const jid = parseUserFromMention(args[0]);
            if (!jid) { await sock.sendMessage(chatId, { text: 'User invalid' }); return; }
            if (mockTargets[jid]) {
                await sock.sendMessage(chatId, { text: 'Mock deja activ' });
                return;
            }
            mockTargets[jid] = true;
            await sock.sendMessage(chatId, { text: `Mock activat: ${jid.split('@')[0]}` });
            return;
        }
        if (cmd === 'stopmock') {
            if (!args.length) {
                const keys = Object.keys(mockTargets);
                if (!keys.length) { await sock.sendMessage(chatId, { text: 'Niciun mock activ' }); return; }
                for (const k of keys) { delete mockTargets[k]; delete mockLastTime[k]; }
                await sock.sendMessage(chatId, { text: `Mock oprit pentru toti (${keys.length})` });
                return;
            }
            const jid = parseUserFromMention(args[0]);
            if (!jid) { await sock.sendMessage(chatId, { text: 'User invalid' }); return; }
            if (!mockTargets[jid]) { await sock.sendMessage(chatId, { text: 'Mock nu era activ' }); return; }
            delete mockTargets[jid];
            delete mockLastTime[jid];
            await sock.sendMessage(chatId, { text: `Mock oprit: ${jid.split('@')[0]}` });
            return;
        }

        // -------- COPYMSG / STOPCOPY --------
        if (cmd === 'copymsg') {
            if (!args.length) {
                await sock.sendMessage(chatId, { text: '$copymsg @user' });
                return;
            }
            const jid = parseUserFromMention(args[0]);
            if (!jid) { await sock.sendMessage(chatId, { text: 'User invalid' }); return; }
            if (copyTargets[jid]) {
                await sock.sendMessage(chatId, { text: 'Copymsg deja activ' });
                return;
            }
            copyTargets[jid] = true;
            await sock.sendMessage(chatId, { text: `Copymsg activat: ${jid.split('@')[0]}` });
            return;
        }
        if (cmd === 'stopcopy') {
            if (!args.length) {
                const keys = Object.keys(copyTargets);
                if (!keys.length) { await sock.sendMessage(chatId, { text: 'Niciun copymsg activ' }); return; }
                for (const k of keys) { delete copyTargets[k]; delete copyLastTime[k]; }
                await sock.sendMessage(chatId, { text: `Copymsg oprit pentru toti (${keys.length})` });
                return;
            }
            const jid = parseUserFromMention(args[0]);
            if (!jid) { await sock.sendMessage(chatId, { text: 'User invalid' }); return; }
            if (!copyTargets[jid]) { await sock.sendMessage(chatId, { text: 'Copymsg nu era activ' }); return; }
            delete copyTargets[jid];
            delete copyLastTime[jid];
            await sock.sendMessage(chatId, { text: `Copymsg oprit: ${jid.split('@')[0]}` });
            return;
        }

        // -------- AUTOREACT / STOPAUTOREACT --------
        if (cmd === 'autoreact') {
            if (args.length < 2) {
                await sock.sendMessage(chatId, { text: '$autoreact @user emoji' });
                return;
            }
            const jid = parseUserFromMention(args[0]);
            if (!jid) { await sock.sendMessage(chatId, { text: 'User invalid' }); return; }
            const emoji = args[1];
            autoreactActive[jid] = emoji;
            await sock.sendMessage(chatId, { text: `Autoreact ${emoji} activat pentru ${jid.split('@')[0]}` });
            return;
        }
        if (cmd === 'stopautoreact') {
            if (!args.length) {
                await sock.sendMessage(chatId, { text: '$stopautoreact @user' });
                return;
            }
            const jid = parseUserFromMention(args[0]);
            if (!jid) { await sock.sendMessage(chatId, { text: 'User invalid' }); return; }
            if (autoreactActive[jid]) {
                delete autoreactActive[jid];
                await sock.sendMessage(chatId, { text: `Autoreact oprit pentru ${jid.split('@')[0]}` });
            } else {
                await sock.sendMessage(chatId, { text: 'Autoreact nu era activ' });
            }
            return;
        }

        // -------- TYPING FAKE --------
        if (cmd === 'typingfake') {
            const targetChat = args[0] || chatId;
            if (typingFakeIntervals.has(targetChat)) {
                await sock.sendMessage(chatId, { text: `Typing fake deja activ pe ${targetChat}` });
                return;
            }
            await sock.sendPresenceUpdate('composing', targetChat);
            const iv = setInterval(async () => {
                if (!typingFakeIntervals.has(targetChat)) { clearInterval(iv); return; }
                await sock.sendPresenceUpdate('composing', targetChat).catch(() => {});
            }, 8000);
            typingFakeIntervals.set(targetChat, iv);
            await sock.sendMessage(chatId, { text: `Typing fake activat pe ${targetChat}` });
            return;
        }
        if (cmd === 'stoptypingfake') {
            if (!args.length) {
                await sock.sendMessage(chatId, { text: '$stoptypingfake [chatID/all]' });
                return;
            }
            if (args[0] === 'all') {
                let count = typingFakeIntervals.size;
                for (const [, iv] of typingFakeIntervals) clearInterval(iv);
                typingFakeIntervals.clear();
                await sock.sendMessage(chatId, { text: `Typing fake oprit pe toate (${count} canale)` });
            } else {
                const targetChat = args[0];
                if (!typingFakeIntervals.has(targetChat)) {
                    await sock.sendMessage(chatId, { text: 'Typing fake nu e activ pe acest chat' });
                    return;
                }
                clearInterval(typingFakeIntervals.get(targetChat));
                typingFakeIntervals.delete(targetChat);
                await sock.sendMessage(chatId, { text: `Typing fake oprit pe ${targetChat}` });
            }
            return;
        }

        // -------- GC (creare grup) --------
        if (cmd === 'gc') {
            if (args.length < 3) {
                await sock.sendMessage(chatId, { text: '$gc [id1] [id2] ... [NumeGrup] [nr]\nEx: $gc 123 456 789 FinesseGang 3' });
                return;
            }
            const lastArg = args[args.length - 1];
            const count = /^\d{1,3}$/.test(lastArg) ? Math.min(parseInt(lastArg), 25) : 1;
            const nameEndIdx = /^\d{1,3}$/.test(lastArg) ? args.length - 2 : args.length - 1;
            const ids = [];
            const nameParts = [];
            for (let i = 0; i <= nameEndIdx; i++) {
                if (/^\d+$/.test(args[i])) ids.push(args[i] + '@s.whatsapp.net');
                else nameParts.push(args[i]);
            }
            if (!ids.length) {
                await sock.sendMessage(chatId, { text: 'Niciun ID valid' });
                return;
            }
            const groupName = nameParts.join(' ') || 'Group';
            await sock.sendMessage(chatId, { text: `Creare ${count} grup${count > 1 ? 'uri' : ''} cu ${ids.length} membri...` });
            let created = 0, failed = 0;
            for (let i = 1; i <= count; i++) {
                try {
                    const name = count > 1 ? `${groupName} ${i}` : groupName;
                    const group = await sock.groupCreate(name, ids);
                    created++;
                } catch (e) {
                    failed++;
                    console.error('[gc]', e);
                }
                await sleep(1200);
            }
            await sock.sendMessage(chatId, { text: `${created}/${count} grupuri create${failed ? ` (${failed} esuate)` : ''}` });
            return;
        }

        // -------- GROUPNAME / STOPGROUPNAME / ADDNOTEPADGROUP / LIST / CLEAR --------
        if (cmd === 'addnotepadgroup') {
            await sock.sendMessage(chatId, { text: '[X] Pentru WhatsApp, incarcati notepadul grup prin editarea manuala a fisierului group_notepad.txt din folderul data/' });
            return;
        }
        if (cmd === 'groupname') {
            if (!args.length) {
                await sock.sendMessage(chatId, { text: '$groupname [JID] - schimba numele grupului din notepad la 2.5s' });
                return;
            }
            const jid = args[0];
            const groupMeta = await sock.groupMetadata(jid).catch(() => null);
            if (!groupMeta) {
                await sock.sendMessage(chatId, { text: 'Nu este un grup valid sau nu am acces.' });
                return;
            }
            const lines = loadLines(GROUP_NOTES_FILE);
            if (!lines.length) {
                await sock.sendMessage(chatId, { text: 'Notepad grup gol. Editeaza manual group_notepad.txt' });
                return;
            }
            if (groupNameInterval) clearInterval(groupNameInterval);
            groupNameTargetJid = jid;
            groupNameIndex = 0;
            groupNameInterval = setInterval(async () => {
                const fresh = loadLines(GROUP_NOTES_FILE);
                if (!fresh.length) return;
                if (groupNameIndex >= fresh.length) groupNameIndex = 0;
                const newName = fresh[groupNameIndex++];
                try {
                    await sock.groupUpdateSubject(groupNameTargetJid, newName);
                } catch (err) {
                    console.error('[groupname]', err);
                }
            }, 2500);
            await sock.sendMessage(chatId, { text: `>> Ciclare nume pornita pentru ${jid} (${lines.length} nume, 2.5s)` });
            return;
        }
        if (cmd === 'stopgroupname') {
            if (!groupNameInterval) {
                await sock.sendMessage(chatId, { text: 'Ciclarea nu ruleaza' });
                return;
            }
            clearInterval(groupNameInterval);
            groupNameInterval = null;
            groupNameTargetJid = null;
            groupNameIndex = 0;
            await sock.sendMessage(chatId, { text: 'Ciclare oprita' });
            return;
        }
        if (cmd === 'listnotepadgroup') {
            const lines = loadLines(GROUP_NOTES_FILE);
            if (!lines.length) {
                await sock.sendMessage(chatId, { text: 'Notepad gol' });
                return;
            }
            await sock.sendMessage(chatId, { text: `**Nume (${lines.length}):**\n${lines.map((l, i) => `${i+1}. ${l}`).join('\n')}` });
            return;
        }
        if (cmd === 'clearnotepadgroup') {
            fs.writeFileSync(GROUP_NOTES_FILE, '');
            await sock.sendMessage(chatId, { text: 'Notepad golit' });
            return;
        }

        // -------- NOTEPAD SPAM/REPLY/BEEF --------
        if (cmd === 'addnotepadspam') {
            await sock.sendMessage(chatId, { text: '[X] Editeaza manual fisierul data/spam_notepad.txt' });
            return;
        }
        if (cmd === 'addnotepadreply') {
            await sock.sendMessage(chatId, { text: '[X] Editeaza manual fisierul data/reply_notepad.txt' });
            return;
        }
        if (cmd === 'addnotepadbeef') {
            await sock.sendMessage(chatId, { text: '[X] Editeaza manual fisierul data/beef_notepad.txt' });
            return;
        }

        // -------- LISTTARGETS --------
        if (cmd === 'listtargets') {
            const lines = [];
            if (replyState.targets.length) lines.push(`REPLY (${replyState.targets.length}): ${replyState.targets.map(j => j.split('@')[0]).join(', ')}`);
            if (aiState.targets.length) lines.push(`AI REPLY (${aiState.targets.length}): ${aiState.targets.map(j => j.split('@')[0]).join(', ')}`);
            const crKeys = Object.keys(customReplyState);
            if (crKeys.length) lines.push(`CUSTOMREPLY (${crKeys.length}): ${crKeys.map(j => j.split('@')[0]).join(', ')}`);
            const mkKeys = Object.keys(mockTargets);
            if (mkKeys.length) lines.push(`MOCK (${mkKeys.length}): ${mkKeys.map(j => j.split('@')[0]).join(', ')}`);
            const cpKeys = Object.keys(copyTargets);
            if (cpKeys.length) lines.push(`COPYMSG (${cpKeys.length}): ${cpKeys.map(j => j.split('@')[0]).join(', ')}`);
            const arKeys = Object.keys(autoreactActive);
            if (arKeys.length) lines.push(`AUTOREACT (${arKeys.length}): ${arKeys.map(j => j.split('@')[0] + ' ' + autoreactActive[j]).join(', ')}`);
            if (spamState.running) lines.push(`SPAM: activ (tip: ${spamState.type || '?'})`);
            if (beeferState.running) lines.push(`AUTOBEEFER: activ`);
            if (repeatState.running) lines.push(`REPEAT: activ`);
            if (groupNameInterval) lines.push(`GROUPNAME: activ pe ${groupNameTargetJid || '?'}`);
            if (!lines.length) { await sock.sendMessage(chatId, { text: 'Niciun target activ' }); return; }
            await sock.sendMessage(chatId, { text: 'TARGETI ACTIVI:\n' + lines.join('\n') });
            return;
        }

        // -------- CLEARALL --------
        if (cmd === 'clearall') {
            replyState.running = false; replyState.targets = []; replyState.lastReplyTime = {}; replyState.replyDelays = {};
            aiState.running = false; aiState.targets = []; aiState.history = {};
            for (const k of Object.keys(customReplyState)) delete customReplyState[k];
            for (const k of Object.keys(mockTargets)) { delete mockTargets[k]; delete mockLastTime[k]; }
            for (const k of Object.keys(copyTargets)) { delete copyTargets[k]; delete copyLastTime[k]; }
            clearAllIntervals();
            spamState.running = false; spamState.target = null;
            repeatState.running = false;
            beeferState.running = false; beeferState.target = null;
            for (const k of Object.keys(autoreactActive)) delete autoreactActive[k];
            afkMode = false; afkReason = '';
            afkCheckMode = false;
            reverseMode = false; mentionTarget = null;
            await sock.sendMessage(chatId, { text: 'CLEARALL - toate automatizarile oprite' });
            return;
        }

        // -------- DACA NU SE POTRIVESTE NICI UNA --------
        await sock.sendMessage(chatId, { text: `[X] Comanda necunoscuta: ${cmd}\nFoloseste $help pentru lista.` });
    }

    console.log(`${SCRIPT_NAME} pornit. Scaneaza QR-ul pentru a te conecta.`);
}

// ========== LINE INTERFACE (pentru comenzi manuale) ==========
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].toLowerCase();

    if (cmd === 'exit' || cmd === 'quit') {
        console.log('Oprire selfbot...');
        process.exit(0);
    }

    console.log(`Comanda console: ${cmd} nu este implementata.`);
});

// ========== GESTIONARE ERORI GLOBALE ==========
// Previne crash-ul botului la erori neasteptate
process.on('uncaughtException', (err) => {
    console.error('[EROARE NECAPTURATA]', err.message);
    // Nu iesim din proces, lasam botul sa continue
});

process.on('unhandledRejection', (reason) => {
    console.error('[PROMISE NETRATAT]', reason);
    // Nu iesim din proces
});

// ========== START ==========
startBot().catch(err => {
    console.error('[FATAL]', err);
    process.exit(1);
});