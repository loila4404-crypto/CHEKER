require("dotenv").config();
const {
  readAccountsFromSheet,
  updateSheetRow,
  appendSheetRow,
  readTelegramFromSheet,
  updateTelegramSheetRow,
  clearWhatsAppSheetRow,
  clearTelegramSheetRow
} = require("./services/googleSheets");

const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const {
  registerTelegramHandlers
} = require("./handlers/telegramHandlers");

const {
  autoLoadSessions
} = require("./services/autoload");

const {
  getTelegramApiApp
} = require("./services/telegramApi");

const {
  isAdmin
} = require("./services/admins");

const {
  markSheetBanAndReport
} = require("./services/reports");

const {
  startWhatsApp
} = require("./services/whatsapp");

const {
  saveStatus,
  syncWhatsAppSheetWithSupabase,
  syncTelegramSheetWithSupabase
} = require("./services/waAccounts");

const {
  registerHealthRoutes
} = require("./routes/health");

const {
  getProxyForPhone
} = require("./services/proxy");

const {
  uploadSessionToStorage,
  restoreSessionFromStorage
} = require("./services/storage");


const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_ID);
const REPORT_CHAT_ID = process.env.REPORT_CHAT_ID;
const SESSION_SECRET = process.env.SESSION_SECRET;
const BOT_MODE = process.env.BOT_MODE || "main";
const SESSION_BUCKET = "wa-sessions";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const bot = new TelegramBot(BOT_TOKEN, {
  polling: BOT_MODE === "main"
});

const app = express();

const waitingForWhatsApp = new Set();
const waitingForDelete = new Set();
const waitingForTelegramAdd = new Set();
const clientWaState = new Map();
const activeSessions = new Map();
const deletingWaPhones = new Set();
const saveTimers = new Map();
const tgUsers = new Set();

let waSheetIntervalMs = 30 * 60 * 1000;
let waSheetIntervalTimer = null;

registerHealthRoutes(app);

bot.on("message", async (msg) => {
  try {
    if (!msg.chat || !msg.from) return;

    if (
      msg.chat.type !== "group" &&
      msg.chat.type !== "supergroup"
    ) {
      return;
    }

    console.log(
      "CHECKER GROUP ID:",
      msg.chat.id
    );

    await supabase
      .from("tg_group_users")
      .upsert({
        chat_id: String(msg.chat.id),
        user_id: String(msg.from.id),
        username: msg.from.username || null,
        first_name: msg.from.first_name || null,
        last_name: msg.from.last_name || null,
        updated_at: new Date().toISOString()
      }, {
        onConflict: "chat_id,user_id"
      });

    await supabase
      .from("tg_groups")
      .upsert({
        chat_id: String(msg.chat.id),
        title: msg.chat.title || null,
        updated_at: new Date().toISOString()
      }, {
        onConflict: "chat_id"
      });

  } catch (err) {
    console.log(
      "Group tracker error:",
      err.message
    );
  }
});

if (BOT_MODE === "main") {
  registerTelegramHandlers({
    bot,
    supabase,
    isAdmin,
    ADMIN_ID,
    clientWaState,
    waitingForDelete,
    waitingForTelegramAdd,
    deleteAccountFromSystem,
    syncWhatsAppSheetWithSupabase,
    markTelegramActiveByUsername,
    makeToken,
    getAccountsStatusText,
    getWaSheetIntervalMs: () => waSheetIntervalMs,
    setWaSheetIntervalMs: (value) => {
      waSheetIntervalMs = value;
    },
    startWaSheetAutoImportInterval,
    appendSheetRow,
    readAccountsFromSheet,
    updateSheetRow,
    readTelegramFromSheet,
    updateTelegramSheetRow,
    startWhatsApp,
    activeSessions,
    scheduleSessionUpload,
    saveStatus,
    markSheetBanAndReport,
    tgUsers
  });
}

setInterval(async () => {
  try {
    console.log("WA sheet sync by timer started");

    await syncWhatsAppSheetWithSupabase({
      supabase
    });
    await syncTelegramSheetWithSupabase({
      supabase
    });
    
    console.log("WA sheet sync by timer finished");
  } catch (err) {
    console.log(
      "WA sheet sync by timer error:",
      err.message
    );
  }
}, 5 * 60 * 1000);

app.listen(process.env.PORT || 3000, () => {
  console.log("Health server started");
});

function getKey() {
  return crypto
    .createHash("sha256")
    .update(SESSION_SECRET)
    .digest();
}

const nodeCrypto = require("crypto");

function makeToken() {
  return nodeCrypto
    .randomBytes(6)
    .toString("hex");
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


function scheduleSessionUpload(phone) {
  if (saveTimers.has(phone)) {
    clearTimeout(saveTimers.get(phone));
  }

  const timer = setTimeout(async () => {
    await uploadSessionToStorage({
      phone,
      supabase,
      sessionSecret: SESSION_SECRET,
      bucket: SESSION_BUCKET
    });

    saveTimers.delete(phone);
  }, 5000);

  saveTimers.set(phone, timer);
}

let sheetAutoImportRunning = false;

async function autoImportWhatsAppFromSheet() {
  if (sheetAutoImportRunning) return;

  sheetAutoImportRunning = true;

  try {
    const rows = await readAccountsFromSheet();

    for (let i = 0; i < rows.length; i++) {
      const rowNumber = i + 2;

      const id = rows[i][0] || "";
      const type = rows[i][1] || "";
      const account = rows[i][2] || "";
      const status = rows[i][3] || "";
      const adName = rows[i][4] || "";
      const operator = rows[i][5] || "";

      const sheetStatus = String(status)
        .trim()
        .toUpperCase();

      if (type !== "WhatsApp") continue;
      if (!["CONNECTION", "CONNECTED"].includes(sheetStatus)) continue;
      if (!account) continue;

      const phone = String(account).replace(/[^\d]/g, "");

      if (!phone || phone.length < 8) continue;

      const { data: existing } = await supabase
        .from("wa_accounts")
        .select("*")
        .eq("phone", phone)
        .single();

      if (!existing) continue;

      const existingStatus = String(existing.status || "")
        .trim()
        .toLowerCase();

      if (
        existingStatus !== "connected" &&
        existingStatus !== "active" &&
        existingStatus !== "open"
      ) {
        continue;
      }

      await updateSheetRow(rowNumber, [
        existing.id || id,
        "WhatsApp",
        phone,
        "ACTIVE",
        adName,
        operator
      ]);

      console.log(`Sheet WA activated: ${phone}`);
    }
  } catch (err) {
    console.log("autoImportWhatsAppFromSheet error:", err.message);
  } finally {
    sheetAutoImportRunning = false;
  }
}

function startWaSheetAutoImportInterval() {
  if (waSheetIntervalTimer) {
    clearInterval(waSheetIntervalTimer);
  }

  waSheetIntervalTimer = setInterval(
    autoImportWhatsAppFromSheet,
    waSheetIntervalMs
  );

  console.log(
    `WA Sheet auto import interval: ${waSheetIntervalMs / 60000} min`
  );
}

startWaSheetAutoImportInterval();

const tgSheetUpdateCache = new Map();

async function markTelegramActiveByUsername(username) {
  if (!username) return;

  const cleanUsername = String(username)
    .replace("@", "")
    .trim()
    .toLowerCase();

  if (!cleanUsername) return;

  try {
    const lastUpdate =
      tgSheetUpdateCache.get(cleanUsername);

    if (
      lastUpdate &&
      Date.now() - lastUpdate < 10 * 60 * 1000
    ) {
      console.log(
        `TG skip sheet update cooldown: ${cleanUsername}`
      );

      return;
    }

    const { data: tgUser } = await supabase
      .from("tg_group_users")
      .select("*")
      .or(
        `username.ilike.${cleanUsername},username.ilike.@${cleanUsername}`
      )
      .limit(1)
      .single();

    if (!tgUser) {
      return;
    }

    const rows =
      await readTelegramFromSheet();

    for (let i = 0; i < rows.length; i++) {
      const rowNumber = i + 3;

      const id = rows[i][0] || "";
      const type = rows[i][1] || "";
      const account =
        rows[i][2] || "";
      const status =
        rows[i][3] || "";
      const adName =
        rows[i][4] || "";
      const operator =
        rows[i][5] || "";

      const sheetUsername = String(account)
        .replace("@", "")
        .trim()
        .toLowerCase();

      const currentStatus = String(status || "")
        .trim()
        .toUpperCase();

      if (type !== "Telegramm") {
        continue;
      }

      if (
        sheetUsername !== cleanUsername
      ) {
        continue;
      }

      if (currentStatus === "ACTIVE") {
        console.log(
          `TG already ACTIVE: ${cleanUsername}`
        );

        tgSheetUpdateCache.set(
          cleanUsername,
          Date.now()
        );

        return;
      }

      if (currentStatus !== "CONNECTION") {
        continue;
      }

      await updateTelegramSheetRow(
        rowNumber,
        [
          id,
          "Telegramm",
          account,
          "ACTIVE",
          adName,
          operator
        ]
      );

      tgSheetUpdateCache.set(
        cleanUsername,
        Date.now()
      );

      console.log(
        `TG activated from sheet: ${cleanUsername}`
      );

      return;
    }
  } catch (err) {
    console.log(
      "markTelegramActiveByUsername error:",
      err.message
    );
  }
}

async function getAccountsStatusText() {
  console.log("STATUS BUTTON CLICKED");

  const waRows = await readAccountsFromSheet();
  const tgRows = await readTelegramFromSheet();

  const waSheetAccounts = waRows
    .map(row =>
      String(row[2] || "")
        .replace(/[^\d]/g, "")
    )
    .filter(phone => phone.length >= 8);

  const tgSheetAccounts = tgRows
    .map(row =>
      String(row[2] || "")
        .replace("@", "")
        .trim()
        .toLowerCase()
    )
    .filter(Boolean);

  const { data: waAccounts, error: waError } = await supabase
    .from("wa_accounts")
    .select("phone,status");

  if (waError) {
    console.log(
      "WA status read error:",
      waError.message
    );
  }

  const { data: tgUsers, error: tgError } = await supabase
    .from("tg_group_users")
    .select("username,is_bot");

  if (tgError) {
    console.log(
      "TG status read error:",
      tgError.message
    );
  }

  const connectedStatuses = [
    "connected",
    "active",
    "open"
  ];

  const waConnected = (waAccounts || [])
    .filter(acc => {
      const accPhone = String(acc.phone || "")
        .replace(/[^\d]/g, "");

      const accStatus = String(acc.status || "")
        .trim()
        .toLowerCase();

      return (
        waSheetAccounts.includes(accPhone) &&
        connectedStatuses.includes(accStatus)
      );
    }).length;

  const tgConnected = (tgUsers || [])
    .filter(user => {
      if (user.is_bot === true) {
        return false;
      }

      const username = String(user.username || "")
        .replace("@", "")
        .trim()
        .toLowerCase();

      return tgSheetAccounts.includes(username);
    }).length;

  const waTotal = waSheetAccounts.length;
  const tgTotal = tgSheetAccounts.length;

  return `
📊 <b>СТАТУС АККАУНТОВ</b>

🟢 <b>WhatsApp</b>
В таблице: <b>${waTotal}</b>
Подключено: <b>${waConnected}</b>
Не подключено: <b>${Math.max(waTotal - waConnected, 0)}</b>

🔵 <b>Telegram</b>
В таблице: <b>${tgTotal}</b>
Подключено: <b>${tgConnected}</b>
Не подключено: <b>${Math.max(tgTotal - tgConnected, 0)}</b>
`;
}

async function deleteAccountFromSystem(input, chatId) {
  const raw = String(input || "").trim();

  if (!raw) {
    await bot.sendMessage(
      chatId,
      "❌ Пустое значение."
    );

    return;
  }

  const onlyDigits = raw.replace(/[^\d]/g, "");
  const isPhone = onlyDigits.length >= 8;

  // WhatsApp
  if (isPhone) {
    const phone = onlyDigits;
deletingWaPhones.add(phone);
    try {
      const waSession =
        activeSessions.get(phone);

      if (
        waSession &&
        typeof waSession.logout === "function"
      ) {
        await waSession.logout();
      }

      if (
        waSession &&
        typeof waSession.end === "function"
      ) {
        waSession.end();
      }
    } catch (err) {
      console.log(
        "WA logout error:",
        err.message
      );
    }

    activeSessions.delete(phone);

    if (saveTimers.has(phone)) {
      clearTimeout(saveTimers.get(phone));
      saveTimers.delete(phone);
    }

    await supabase
      .from("wa_accounts")
      .delete()
      .eq("phone", phone);

    try {
      await supabase.storage
        .from(SESSION_BUCKET)
        .remove([
          `wa_${phone}/session.tar.gz.enc`
        ]);
    } catch (err) {
      console.log(
        "WA session remove error:",
        err.message
      );
    }

    try {
      const sessionDir = path.join(
        __dirname,
        "sessions",
        `wa_${phone}`
      );

      await fsp.rm(sessionDir, {
        recursive: true,
        force: true
      });
    } catch (err) {
      console.log(
        "Local WA session remove error:",
        err.message
      );
    }

    const rows =
      await readAccountsFromSheet();

    let cleared = false;

    for (let i = 0; i < rows.length; i++) {
      const rowNumber = i + 3;

      const account = rows[i][2] || "";

      const sheetPhone = String(account)
        .replace(/[^\d]/g, "");

      if (sheetPhone === phone) {
        await updateSheetRow(rowNumber, [
          "",
          "WhatsApp",
          "",
          "",
          "",
          ""
        ]);

        console.log(
          `WA sheet row cleared: ${rowNumber}`
        );

        cleared = true;
        break;
      }
    }

    if (!cleared) {
      console.log(
        `WA sheet row not found for delete: ${phone}`
      );
    }

    await bot.sendMessage(
      chatId,
      `✅ WhatsApp полностью удалён и разлогинен: ${phone}`
    );

    return;
  }

  // Telegram
  const username = raw
    .replace("@", "")
    .trim()
    .toLowerCase();

  if (!username) {
    await bot.sendMessage(
      chatId,
      "❌ Неверный Telegram username."
    );

    return;
  }

  const { data: tgUsers } =
    await supabase
      .from("tg_group_users")
      .select("*")
      .or(
        `username.ilike.${username},username.ilike.@${username}`
      );

  if (tgUsers && tgUsers.length) {
    for (const tgUser of tgUsers) {
      try {
        await bot.banChatMember(
          tgUser.chat_id,
          tgUser.user_id,
          {
            revoke_messages: true
          }
        );

        setTimeout(async () => {
          try {
            await bot.unbanChatMember(
              tgUser.chat_id,
              tgUser.user_id,
              {
                only_if_banned: true
              }
            );
          } catch (err) {
            console.log(
              "TG unban error:",
              err.message
            );
          }
        }, 3000);

      } catch (err) {
        console.log(
          "TG kick error:",
          err.message
        );
      }
    }
  }

  await supabase
    .from("tg_group_users")
    .delete()
    .or(
      `username.ilike.${username},username.ilike.@${username}`
    );

  try {
    await supabase
      .from("tg_group_users")
      .delete()
      .eq("user_id", username);
  } catch (err) {
    console.log(
      "TG delete by user_id error:",
      err.message
    );
  }

  const tgRows =
    await readTelegramFromSheet();

  for (let i = 0; i < tgRows.length; i++) {
    const rowNumber = i + 3;
    const account =
      tgRows[i][2] || "";

    const sheetUsername = String(account)
      .replace("@", "")
      .trim()
      .toLowerCase();

    if (sheetUsername === username) {
      await updateTelegramSheetRow(rowNumber, [
        "",
        "Telegramm",
        "",
        "",
        "",
        ""
      ]);

      console.log(
        `TG sheet row cleared: ${rowNumber}`
      );

      break;
    }
  }

  await bot.sendMessage(
    chatId,
    `✅ Telegram удалён: @${username}`
  );
}

async function checkTelegramDeletedUsers() {
  console.log("TG checker triggered");

  const { data: users, error } = await supabase
    .from("tg_group_users")
    .select("*")
    .eq("is_bot", false)
    .neq("is_deleted", true);

  if (error) {
    console.log("TG checker Supabase error:", error.message);
    return;
  }

  if (!users || !users.length) {
    console.log("TG checker: no users to check");
    return;
  }

  console.log(`TG checker started. Users: ${users.length}`);

  let deleted = [];

  for (const row of users) {
    console.log(`Checking TG user ${row.user_id}`);

    try {
      const member = await bot.getChatMember(row.chat_id, row.user_id);
      const user = member.user;

      const isDeleted =
        user.first_name === "Deleted Account" ||
        user.first_name === "Удалённый аккаунт" ||
        !user.first_name;

      const isLeftOrKicked =
        member.status === "left" ||
        member.status === "kicked";

      const finalDeleted =
        isDeleted || isLeftOrKicked;

      await supabase
        .from("tg_group_users")
        .update({
          username: user.username || null,
          first_name: user.first_name || null,
          last_name: user.last_name || null,
          is_deleted: finalDeleted,
          member_status: member.status,
          last_checked_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq("id", row.id);

      if (finalDeleted) {
        deleted.push({
          id: row.id,
          user_id: row.user_id,
          username: user.username || row.username,
          first_name: user.first_name || row.first_name,
          status: member.status
        });
      }

      await new Promise(resolve => setTimeout(resolve, 700));

    } catch (e) {
      console.log(`TG check error ${row.user_id}:`, e.message);

      await supabase
        .from("tg_group_users")
        .update({
          member_status: "check_error",
          last_error: e.message,
          last_checked_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq("id", row.id);
    }
  }

  if (deleted.length) {
    console.log(`Deleted users found: ${deleted.length}`);

    const text = deleted.map(u => {
      const name =
        u.username
          ? `@${u.username}`
          : u.first_name || "без username";

      return `⛔ ${name} | ID: ${u.user_id} | ${u.status}`;
    }).join("\n");

    await bot.sendMessage(
      REPORT_CHAT_ID,
      `🚨 Telegram deleted/left accounts

${text}`
    );

    for (const u of deleted) {
      await supabase
        .from("tg_group_users")
        .update({
          is_deleted: true,
          member_status: u.status,
          updated_at: new Date().toISOString()
        })
        .eq("id", u.id);
    }
  } else {
    console.log("TG checker finished. No deleted users.");
  }
}

function esc(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function sendHourlyReport() {
  console.log("Hourly WA/TG report started");

  const { data: waAccounts } = await supabase
    .from("wa_accounts")
    .select("*");

  const { data: tgUsers } = await supabase
    .from("tg_group_users")
    .select("*")
    .eq("is_bot", false);

  const waList = waAccounts || [];
  const tgList = tgUsers || [];

  const badWa = waList.filter(acc =>
    acc.status === "logged_out" ||
    acc.status === "need_qr"
  );

  const badTg = tgList.filter(user =>
    (
      user.member_status === "left" ||
      user.member_status === "kicked" ||
      user.member_status === "check_error"
    ) &&
    user.is_deleted !== true
  );

  const badWaText = badWa.length
    ? badWa.map(acc =>
        `• <code>${esc(acc.phone)}</code> — <b>${esc(acc.status)}</b>`
      ).join("\n")
    : "<i>Нет проблем</i>";

  const badTgText = badTg.length
    ? badTg.map(user => {
        const name = user.username
          ? `@${esc(user.username)}`
          : esc(user.first_name || "без username");

        return `• ${name} | ID: <code>${esc(user.user_id)}</code> — <b>${esc(user.member_status || "deleted")}</b>`;
      }).join("\n")
    : "<i>Нет проблем</i>";

  const report = `
<b>📊 WA/TG ОТЧЁТ</b>

<b>🟢 WhatsApp</b>
Проверено: <b>${waList.length}</b>
Проблемы: <b>${badWa.length}</b>

<b>⛔ Проблемные WhatsApp:</b>
${badWaText}

<b>👥 Telegram</b>
Проверено: <b>${tgList.length}</b>
Проблемы: <b>${badTg.length}</b>

<b>⛔ Проблемные Telegram:</b>
${badTgText}

<i>🕒 ${new Date().toLocaleString()}</i>
`;

  await bot.sendMessage(
    REPORT_CHAT_ID,
    report,
    {
      parse_mode: "HTML"
    }
  );

  if (badTg.length) {
    for (const user of badTg) {
      await supabase
        .from("tg_group_users")
        .update({
          is_deleted: true,
          updated_at: new Date().toISOString()
        })
        .eq("user_id", String(user.user_id));
    }
  }

  console.log("Hourly WA/TG report sent");
}

autoLoadSessions({
  supabase,
  REPORT_CHAT_ID,
  startWhatsApp,
  bot,
  SESSION_SECRET,
  SESSION_BUCKET,
  activeSessions,
  deletingWaPhones,
  scheduleSessionUpload,
  saveStatus,
  markSheetBanAndReport,
  WORKER_ID: process.env.WORKER_ID || "worker_1"
});

setInterval(() => {
  checkTelegramDeletedUsers();
}, 60 * 60 * 1000);

setTimeout(() => {
  checkTelegramDeletedUsers();
}, 15000);

setInterval(() => {
  sendHourlyReport();
}, 60 * 60 * 1000);
