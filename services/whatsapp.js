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
  deletingWaPhones,
  scheduleSessionUpload,
  saveStatus,
  markSheetBanAndReport
}) {
  try {
    const existingSession =
      activeSessions.get(phone);

    if (
      existingSession &&
      typeof existingSession.logout === "function"
    ) {
      console.log(
        `WhatsApp ${phone} уже запущен`
      );

      return;
    }

    activeSessions.set(phone, {
      status: "starting"
    });

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

    activeSessions.set(phone, sock);

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

        try {
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

          console.log(
            `WA QR sent: ${phone}`
          );
        } catch (err) {
          console.log(
            `QR send error ${phone}:`,
            err.message
          );
        }
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

        console.log(
          `WA ${phone} connected`
        );
      }

      if (connection === "close") {
        const code =
          lastDisconnect?.error?.output?.statusCode;

        activeSessions.delete(phone);

        if (
          deletingWaPhones &&
          deletingWaPhones.has(phone)
        ) {
          console.log(
            `WA ${phone} удаляется вручную, BAN не ставим`
          );

          deletingWaPhones.delete(phone);
          return;
        }

        if (code === DisconnectReason.loggedOut) {
          await saveStatus({
            phone,
            status: "logged_out",
            error: "Need new QR",
            supabase
          });

          if (typeof markSheetBanAndReport === "function") {
            await markSheetBanAndReport({
              phone,
              reason: "Разлогинен"
            });
          }

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
            deletingWaPhones,
            scheduleSessionUpload,
            saveStatus,
            markSheetBanAndReport
          });
        }, 10000);
      }
    });
  } catch (err) {
    console.log(
      `WA start error ${phone}:`,
      err
    );

    activeSessions.delete(phone);
  }
}

module.exports = {
  startWhatsApp
};
