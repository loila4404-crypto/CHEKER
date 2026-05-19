const P = require("pino");
const QRCode = require("qrcode");

const {
  default: makeWASocket,
  useMultiFileAuthState
} = require("@whiskeysockets/baileys");

const {
  restoreSessionFromStorage
} = require("./storage");

const {
  readAccountsFromSheet,
  updateSheetRow
} = require("./googleSheets");

let checkerSock = null;
let checkerReady = false;

function sleep(ms) {
  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );
}

async function startWaChecker({
  phone,
  chatId,
  bot,
  supabase,
  SESSION_SECRET,
  SESSION_BUCKET,
  scheduleSessionUpload
}) {
  const sessionName = `wa_checker_${phone}`;

  await restoreSessionFromStorage({
    phone: `wa_checker_${phone}`,
    supabase,
    sessionSecret: SESSION_SECRET,
    bucket: SESSION_BUCKET
  });

  const { state, saveCreds } =
    await useMultiFileAuthState(`./sessions/${sessionName}`);

  const sock = makeWASocket({
    auth: state,
    logger: P({ level: "silent" }),
    printQRInTerminal: false
  });

  checkerSock = sock;

  sock.ev.on("creds.update", async () => {
    await saveCreds();

    if (typeof scheduleSessionUpload === "function") {
      scheduleSessionUpload(`wa_checker_${phone}`);
    }
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, qr } = update;

    if (qr) {
      const qrBuffer = await QRCode.toBuffer(qr);

      await bot.sendPhoto(
        chatId,
        qrBuffer,
        {
          caption: `📲 QR для проверяющего WhatsApp ${phone}`
        }
      );

      console.log("WA checker QR sent");
    }

    if (connection === "open") {
      checkerReady = true;

      console.log("WA checker connected");

      await bot.sendMessage(
        chatId,
        `✅ Проверяющий WhatsApp подключен: ${phone}`
      ).catch(() => {});
    }

    if (connection === "close") {
      checkerReady = false;
      checkerSock = null;

      console.log("WA checker disconnected");
    }
  });
}

async function checkWaNumbersExist({
  numbers,
  supabase
}) {
  if (!checkerSock || !checkerReady) {
    console.log("WA checker not ready");
    return;
  }

  for (const rawPhone of numbers) {
    const phone = String(rawPhone || "")
      .replace(/[^\d]/g, "");

    if (!phone || phone.length < 8) continue;

    try {
      const jid = `${phone}@s.whatsapp.net`;

      const result =
        await checkerSock.onWhatsApp(jid);

      const exists =
        Array.isArray(result) &&
        result[0] &&
        result[0].exists === true;

      await supabase
        .from("wa_accounts")
        .update({
          checker_exists: exists,
          checker_last_checked_at: new Date().toISOString(),
          checker_error: null
        })
        .eq("phone", phone);

      console.log(
        `WA checker: ${phone} exists=${exists}`
      );

      await sleep(5000);
    } catch (err) {
      await supabase
        .from("wa_accounts")
        .update({
          checker_last_checked_at: new Date().toISOString(),
          checker_error: err.message
        })
        .eq("phone", phone);

      console.log(
        `WA checker error ${phone}:`,
        err.message
      );
    }
  }
}

async function checkWhatsAppLastSeenFromSheet({
  bot,
  chatId
} = {}) {
  if (!checkerSock || !checkerReady) {
    console.log("WA checker not ready");

    if (bot && chatId) {
      await bot.sendMessage(
        chatId,
        "❌ WA Проверяльщик не подключен. Сначала нажми 🟢 WA Проверяльщик и отскань QR."
      ).catch(() => {});
    }

    return;
  }

  console.log("WA checker sheet scan started");

  if (bot && chatId) {
    await bot.sendMessage(
      chatId,
      "🔍 Начал проверку WhatsApp номеров из таблицы."
    ).catch(() => {});
  }

  const rows = await readAccountsFromSheet();

  let checked = 0;
  let live = 0;
  let ban = 0;
  let hidden = 0;
  let errors = 0;

  for (let i = 0; i < rows.length; i++) {
    const rowNumber = i + 3;

    const id = rows[i][0] || "";
    const type = rows[i][1] || "";
    const account = rows[i][2] || "";
    const oldStatus = rows[i][3] || "";
    const adName = rows[i][4] || "";
    const operator = rows[i][5] || "";

    if (type !== "WhatsApp") {
      continue;
    }

    const phone = String(account)
      .replace(/[^\d]/g, "");

    if (!phone || phone.length < 8) {
      continue;
    }

    checked++;

    try {
      const jid = `${phone}@s.whatsapp.net`;

      const result =
        await checkerSock.onWhatsApp(jid);

      const exists =
        Array.isArray(result) &&
        result[0] &&
        result[0].exists === true;

      let newStatus = "BAN";

      if (!exists) {
        newStatus = "BAN";
        ban++;
      } else {
        try {
          await checkerSock.presenceSubscribe(jid);
          await sleep(4000);

          newStatus = "LIVE";
          live++;
        } catch (err) {
          newStatus = "HIDDEN";
          hidden++;
        }
      }

      await updateSheetRow(rowNumber, [
        id,
        "WhatsApp",
        phone,
        newStatus,
        adName,
        operator
      ]);

      console.log(
        `WA checker sheet ${phone}: ${oldStatus} -> ${newStatus}`
      );
    } catch (err) {
      errors++;

      console.log(
        `WA checker sheet error ${phone}:`,
        err.message
      );

      await updateSheetRow(rowNumber, [
        id,
        "WhatsApp",
        phone,
        "ERROR",
        adName,
        operator
      ]);
    }

    await sleep(10000);
  }

  console.log("WA checker sheet scan finished");

  if (bot && chatId) {
    await bot.sendMessage(
      chatId,
      `✅ Проверка WhatsApp завершена.

Всего проверено: ${checked}
LIVE: ${live}
BAN: ${ban}
HIDDEN: ${hidden}
ERROR: ${errors}`
    ).catch(() => {});
  }
}

module.exports = {
  startWaChecker,
  checkWaNumbersExist,
  checkWhatsAppLastSeenFromSheet
};
