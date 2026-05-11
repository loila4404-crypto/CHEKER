require("dotenv").config();

const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");
const P = require("pino");
const QRCode = require("qrcode");
const { SocksProxyAgent } = require("socks-proxy-agent");

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const tar = require("tar");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_ID);
const REPORT_CHAT_ID = process.env.REPORT_CHAT_ID;
const SESSION_SECRET = process.env.SESSION_SECRET;
const SESSION_BUCKET = "wa-sessions";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const bot = new TelegramBot(BOT_TOKEN, {
  polling: true
});

const app = express();

const waitingForWhatsApp = new Set();
const activeSessions = new Map();
const saveTimers = new Map();

app.get("/", (req, res) => {
  res.send("WA Checker is alive");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString()
  });
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Health server started");
});

async function saveStatus(phone, status, error = null) {
  await supabase
    .from("wa_accounts")
    .upsert({
      phone,
      status,
      last_seen: new Date().toISOString(),
      last_error: error,
      session_path: `sessions/wa_${phone}`,
      updated_at: new Date().toISOString()
    }, {
      onConflict: "phone"
    });
}

function getKey() {
  return crypto
    .createHash("sha256")
    .update(SESSION_SECRET)
    .digest();
}

function encryptBuffer(buffer) {
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    getKey(),
    iv
  );

  const encrypted = Buffer.concat([
    cipher.update(buffer),
    cipher.final()
  ]);

  const tag = cipher.getAuthTag();

  return Buffer.concat([iv, tag, encrypted]);
}

function decryptBuffer(buffer) {
  const iv = buffer.subarray(0, 12);
  const tag = buffer.subarray(12, 28);
  const encrypted = buffer.subarray(28);

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getKey(),
    iv
  );

  decipher.setAuthTag(tag);

  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final()
  ]);
}

async function uploadSessionToStorage(phone) {
  if (!SESSION_SECRET) {
    console.log("SESSION_SECRET is missing");
    return;
  }

  const sessionDir = path.join(__dirname, "sessions", `wa_${phone}`);

  if (!fs.existsSync(sessionDir)) {
    return;
  }

  const tmpTar = path.join(__dirname, `wa_${phone}.tar.gz`);
  const storagePath = `wa_${phone}/session.tar.gz.enc`;

  await tar.c(
    {
      gzip: true,
      file: tmpTar,
      cwd: path.join(__dirname, "sessions")
    },
    [`wa_${phone}`]
  );

  const raw = await fsp.readFile(tmpTar);
  const encrypted = encryptBuffer(raw);

  const { error } = await supabase.storage
    .from(SESSION_BUCKET)
    .upload(storagePath, encrypted, {
      upsert: true,
      contentType: "application/octet-stream"
    });

  await fsp.unlink(tmpTar).catch(() => {});

  if (error) {
    console.log(`Upload session error ${phone}:`, error.message);
    return;
  }

  console.log(`Session ${phone} uploaded to Supabase Storage`);
}

async function restoreSessionFromStorage(phone) {
  if (!SESSION_SECRET) {
    console.log("SESSION_SECRET is missing");
    return;
  }

  const sessionRoot = path.join(__dirname, "sessions");
  const sessionDir = path.join(sessionRoot, `wa_${phone}`);
  const tmpTar = path.join(__dirname, `restore_${phone}.tar.gz`);
  const storagePath = `wa_${phone}/session.tar.gz.enc`;

  if (fs.existsSync(sessionDir)) {
    return;
  }

  const { data, error } = await supabase.storage
    .from(SESSION_BUCKET)
    .download(storagePath);

  if (error || !data) {
    console.log(`No saved session for ${phone}`);
    return;
  }

  await fsp.mkdir(sessionRoot, { recursive: true });

  const encrypted = Buffer.from(await data.arrayBuffer());
  const decrypted = decryptBuffer(encrypted);

  await fsp.writeFile(tmpTar, decrypted);

  await tar.x({
    file: tmpTar,
    cwd: sessionRoot
  });

  await fsp.unlink(tmpTar).catch(() => {});

  console.log(`Session ${phone} restored from Supabase Storage`);
}

function scheduleSessionUpload(phone) {
  if (saveTimers.has(phone)) {
    clearTimeout(saveTimers.get(phone));
  }

  const timer = setTimeout(async () => {
    await uploadSessionToStorage(phone);
    saveTimers.delete(phone);
  }, 5000);

  saveTimers.set(phone, timer);
}

async function getProxyForPhone(phone) {
  const { data: account } = await supabase
    .from("wa_accounts")
    .select("proxy_id")
    .eq("phone", phone)
    .single();

  if (account?.proxy_id) {
    const { data: proxy } = await supabase
      .from("proxies")
      .select("*")
      .eq("id", account.proxy_id)
      .eq("active", true)
      .single();

    return proxy || null;
  }

  const { data: proxies, error } = await supabase
    .from("proxies")
    .select("*")
    .eq("active", true);

  if (error || !proxies || !proxies.length) {
    return null;
  }

  const { data: usedAccounts } = await supabase
    .from("wa_accounts")
    .select("proxy_id")
    .not("proxy_id", "is", null);

  const usedProxyIds = new Set(
    (usedAccounts || []).map(acc => acc.proxy_id)
  );

  const freeProxy =
    proxies.find(proxy => !usedProxyIds.has(proxy.id)) || proxies[0];

  await supabase
    .from("wa_accounts")
    .update({ proxy_id: freeProxy.id })
    .eq("phone", phone);

  return freeProxy;
}

async function startWhatsApp(phone, chatId) {
  if (activeSessions.has(phone)) {
    await bot.sendMessage(chatId, `⚠️ WhatsApp ${phone} уже запущен`);
    return;
  }

  activeSessions.set(phone, true);

  await restoreSessionFromStorage(phone);

  const sessionPath = `./sessions/wa_${phone}`;

  const { state, saveCreds } =
    await useMultiFileAuthState(sessionPath);

  const proxy = await getProxyForPhone(phone);

  let agent = undefined;

  if (proxy) {
    const auth =
      proxy.username && proxy.password
        ? `${proxy.username}:${proxy.password}@`
        : "";

    const proxyUrl =
      `${proxy.type}://${auth}${proxy.host}:${proxy.port}`;

    agent = new SocksProxyAgent(proxyUrl);

    console.log(
      `Using proxy for ${phone}: ${proxy.host}:${proxy.port}`
    );
  } else {
    console.log(
      `No proxy for ${phone}, using server IP`
    );
  }

  const sock = makeWASocket({
    auth: state,
    logger: P({ level: "silent" }),
    printQRInTerminal: false,
    agent,
    fetchAgent: agent
  });

  sock.ev.on("creds.update", async () => {
    await saveCreds();
    scheduleSessionUpload(phone);
  });

  sock.ev.on("connection.update", async (update) => {
    const {
      connection,
      qr,
      lastDisconnect
    } = update;

    if (qr) {
      console.log(`QR for ${phone}`);

      await saveStatus(phone, "need_qr");

      const qrBuffer = await QRCode.toBuffer(qr, {
        type: "png",
        width: 500
      });

      await bot.sendPhoto(
        chatId,
        qrBuffer,
        {
          caption: `📲 Отсканируй QR для WhatsApp ${phone}`
        }
      );
    }

    if (connection === "open") {
      console.log(`WhatsApp ${phone} connected`);

      await saveStatus(phone, "connected");
      await uploadSessionToStorage(phone);

      await bot.sendMessage(
        chatId,
        `✅ WhatsApp ${phone} подключен`
      );
    }

    if (connection === "close") {
      const code =
        lastDisconnect?.error?.output?.statusCode;

      console.log(
        `WhatsApp ${phone} disconnected`,
        code
      );

      activeSessions.delete(phone);

      if (code === DisconnectReason.loggedOut) {
        await saveStatus(
          phone,
          "logged_out",
          "Need new QR"
        );

        await bot.sendMessage(
          chatId,
          `⛔ WhatsApp ${phone} разлогинен`
        );

        return;
      }

      await saveStatus(
        phone,
        "disconnected",
        `Disconnect code: ${code}`
      );

      await bot.sendMessage(
        chatId,
        `⚠️ WhatsApp ${phone} отключился`
      );

      setTimeout(() => {
        startWhatsApp(phone, chatId);
      }, 10000);
    }
  });
}

bot.onText(/\/start/, async (msg) => {
  if (String(msg.from.id) !== ADMIN_ID) return;

  await bot.sendMessage(
    msg.chat.id,
    `👋 WA Checker готов`,
    {
      reply_markup: {
        keyboard: [
          ["➕ Добавить WhatsApp"],
          ["➕ Добавить Telegram"],
          ["📊 Статус"]
        ],
        resize_keyboard: true
      }
    }
  );
});

bot.onText(/\/status/, async (msg) => {
  if (String(msg.from.id) !== ADMIN_ID) {
    return;
  }

  const { data, error } =
    await supabase
      .from("wa_accounts")
      .select("*")
      .order("created_at", {
        ascending: false
      });

  if (error) {
    await bot.sendMessage(
      msg.chat.id,
      `❌ Ошибка Supabase`
    );

    return;
  }

  if (!data || !data.length) {
    await bot.sendMessage(
      msg.chat.id,
      `Нет WhatsApp`
    );

    return;
  }

  const text = data.map(acc => {
    let icon = "⚪";

    if (acc.status === "connected") icon = "🟢";
    if (acc.status === "need_qr") icon = "📲";
    if (acc.status === "logged_out") icon = "⛔";
    if (acc.status === "disconnected") icon = "🔴";
    if (acc.status === "starting") icon = "⏳";

    return `${icon} ${acc.phone} — ${acc.status}`;
  }).join("\n");

  await bot.sendMessage(
    msg.chat.id,
    `📊 WA Status

${text}`
  );
});

async function autoLoadSessions() {
  const { data, error } =
    await supabase
      .from("wa_accounts")
      .select("*");

  if (error) {
    console.log("Auto load error", error);
    return;
  }

  if (!data || !data.length) {
    console.log("No sessions to autoload");
    return;
  }

  console.log(`Autoloading ${data.length} sessions`);

  for (const acc of data) {
    try {
      console.log(`Starting ${acc.phone}`);

      startWhatsApp(
        acc.phone,
        REPORT_CHAT_ID
      );

      await new Promise(resolve =>
        setTimeout(resolve, 5000)
      );

    } catch (e) {
      console.log(
        `Autoload failed ${acc.phone}`,
        e
      );
    }
  }
}

setTimeout(() => {
  autoLoadSessions();
}, 5000);
