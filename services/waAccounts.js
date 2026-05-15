const {
  readAccountsFromSheet,
  updateSheetRow,
  readTelegramFromSheet,
  updateTelegramSheetRow
} = require("./googleSheets");

async function saveStatus({
  phone,
  status,
  error = null,
  supabase
}) {
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

  console.log(
    `WA status saved only to Supabase: ${phone} -> ${status}`
  );
}

function normalizePhone(value) {
  return String(value || "")
    .replace(/[^\d]/g, "");
}

function normalizeUsername(value) {
  return String(value || "")
    .replace("@", "")
    .trim()
    .toLowerCase();
}

function normalizeStatus(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function getSheetStatusByWaStatus(status) {
  const normalized = String(status || "")
    .trim()
    .toLowerCase();

  if (
    [
      "connected",
      "active",
      "open"
    ].includes(normalized)
  ) {
    return "ACTIVE";
  }

  return "CONNECTION";
}

async function syncWhatsAppSheetWithSupabase({
  supabase
}) {
  try {
    console.log("WA sheet sync started");

    const rows = await readAccountsFromSheet();

    const { data: waAccounts, error } = await supabase
      .from("wa_accounts")
      .select("phone,status");

    if (error) {
      console.log(
        "WA sync Supabase error:",
        error.message
      );

      return;
    }

    const statusByPhone = new Map();

    for (const acc of waAccounts || []) {
      const phone = normalizePhone(acc.phone);

      if (!phone || phone.length < 8) continue;

      statusByPhone.set(
        phone,
        getSheetStatusByWaStatus(acc.status)
      );
    }

    let updated = 0;
    let checked = 0;

    for (let i = 0; i < rows.length; i++) {
      const rowNumber = i + 3;

      const id = rows[i][0] || "";
      const type = rows[i][1] || "";
      const account = rows[i][2] || "";
      const sheetStatus = rows[i][3] || "";
      const adName = rows[i][4] || "";
      const operator = rows[i][5] || "";

      const sheetType = String(type || "")
        .trim()
        .toLowerCase();

      const sheetPhone = normalizePhone(account);

      if (sheetType !== "whatsapp") continue;
      if (!sheetPhone || sheetPhone.length < 8) continue;

      checked++;

      const newStatus =
        statusByPhone.get(sheetPhone) || "CONNECTION";

      if (normalizeStatus(sheetStatus) === newStatus) {
        continue;
      }

      await updateSheetRow(rowNumber, [
        id,
        "WhatsApp",
        account,
        newStatus,
        adName,
        operator
      ]);

      updated++;

      console.log(
        `WA sheet synced: row ${rowNumber}, ${sheetPhone} -> ${newStatus}`
      );
    }

    console.log(
      `WA sheet sync finished. Checked: ${checked}. Updated: ${updated}`
    );
  } catch (err) {
    console.log(
      "WA sheet sync error:",
      err.message
    );
  }
}

async function syncTelegramSheetWithSupabase({
  supabase
}) {
  try {
    console.log("TG sheet sync started");

    const rows = await readTelegramFromSheet();

    const { data: tgUsers, error } = await supabase
      .from("tg_group_users")
      .select("username,is_bot");

    if (error) {
      console.log(
        "TG sync Supabase error:",
        error.message
      );

      return;
    }

    const activeUsernames = new Set(
      (tgUsers || [])
        .filter(user => user.is_bot !== true)
        .map(user => normalizeUsername(user.username))
        .filter(Boolean)
    );

    let updated = 0;
    let checked = 0;

    for (let i = 0; i < rows.length; i++) {
      const rowNumber = i + 3;

      const id = rows[i][0] || "";
      const type = rows[i][1] || "";
      const account = rows[i][2] || "";
      const sheetStatus = rows[i][3] || "";
      const adName = rows[i][4] || "";
      const operator = rows[i][5] || "";

      const sheetType = String(type || "")
        .trim()
        .toLowerCase();

      const username = normalizeUsername(account);

      if (
        sheetType !== "telegram" &&
        sheetType !== "telegramm" &&
        sheetType !== "tg"
      ) {
        continue;
      }

      if (!username) continue;

      checked++;

      const newStatus = activeUsernames.has(username)
        ? "ACTIVE"
        : "CONNECTION";

      if (normalizeStatus(sheetStatus) === newStatus) {
        continue;
      }

      await updateTelegramSheetRow(rowNumber, [
        id,
        type || "Telegram",
        account,
        newStatus,
        adName,
        operator
      ]);

      updated++;

      console.log(
        `TG sheet synced: row ${rowNumber}, @${username} -> ${newStatus}`
      );
    }

    console.log(
      `TG sheet sync finished. Checked: ${checked}. Updated: ${updated}`
    );
  } catch (err) {
    console.log(
      "TG sheet sync error:",
      err.message
    );
  }
}

module.exports = {
  saveStatus,
  syncWhatsAppSheetWithSupabase,
  syncTelegramSheetWithSupabase
};
