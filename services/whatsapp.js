const P = require("pino");
const QRCode = require("qrcode");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const {
  SocksProxyAgent
} = require("socks-proxy-agent");

const {
  restoreSessionFromStorage,
  uploadSessionToStorage
} = require("./storage");

const {
  getProxyForPhone
} = require("./proxy");

async function startWhatsApp({
  phone,
  chatId,
  bot,
  supabase,
  SESSION_SECRET,
  SESSION_BUCKET,
  activeSessions,
  scheduleSessionUpload,
  saveStatus,
  markSheetBanAndReport
}) {
  if (activeSessions.has(phone)) {
    await bot.sendMessage(
      chatId,
      `⚠️ WhatsApp ${phone} уже запущен`
    );

    return;
  }

  activeSessions.set(phone, true);

  await restoreSessionFromStorage({
    phone,
    supabase,
    sessionSecret: SESSION_SECRET,
    bucket: SESSION_BUCKET
  });

  const sessionPath = `./sessions/wa_${phone}`;

  const { state, saveCreds } =
    await useMultiFileAuthState(sessionPath);

  const proxy = await getProxyForPhone({
    phone,
    supabase
  });

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
      await saveStatus({
        phone,
        status: "need_qr",
        supabase
      });

      const qrBuffer =
        await QRCode.toBuffer(qr);

      await bot.sendPhoto(
        chatId,
        qrBuffer,
        {
          caption:
            `📲 QR для WhatsApp ${phone}`
        }
      );
    }

    if (connection === "open") {
      await saveStatus({
        phone,
        status: "connected",
        supabase
      });

      await uploadSessionToStorage({
        phone,
        supabase,
        sessionSecret: SESSION_SECRET,
        bucket: SESSION_BUCKET
      });
    }

    if (connection === "close") {
      const code =
        lastDisconnect?.error?.output?.statusCode;

      activeSessions.delete(phone);

      if (code === DisconnectReason.loggedOut) {
        await saveStatus({
          phone,
          status: "logged_out",
          error: "Need new QR",
          supabase
        });

        await markSheetBanAndReport(
          phone,
          "Разлогинен"
        );

        return;
      }

      await saveStatus({
        phone,
        status: "disconnected",
        error: `Disconnect code: ${code}`,
        supabase
      });

      setTimeout(() => {
        startWhatsApp({
          phone,
          chatId,
          bot,
          supabase,
          SESSION_SECRET,
          SESSION_BUCKET,
          activeSessions,
          scheduleSessionUpload,
          saveStatus,
          markSheetBanAndReport
        });
      }, 10000);
    }
  });
}

module.exports = {
  startWhatsApp
};