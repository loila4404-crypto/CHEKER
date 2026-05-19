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
  return String(value || "").replace(/[^\d]/g, "");
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

function getKyivNow() {
  return new Date(
    new Date().toLocaleString("en-US", {
      timeZone: "Europe/Kyiv"
    })
  );
}

function parseWaLastSeen(lastSeen) {
  const text = String(lastSeen || "")
    .trim()
    .toLowerCase();

  if (!text) return null;

  if (text === "в сети" || text === "online") {
    return getKyivNow();
  }

  const timeMatch = text.match(/(\d{1,2}):(\d{2})/);

  if (!timeMatch) return null;

  const hours = Number(timeMatch[1]);
  const minutes = Number(timeMatch[2]);

  const now = getKyivNow();
  const date = new Date(now);

  if (
    text.includes("вчера") ||
    text.includes("yesterday")
  ) {
    date.setDate(date.getDate() - 1);
  }

  date.setHours(hours, minutes, 0, 0);

  return date;
}

function getWaStatusByLastSeen(lastSeen) {
  const text = String(lastSeen || "")
    .trim()
    .toLowerCase();

  if (!text) return "UNKNOWN";

  if (text === "в сети" || text === "online") {
    return "ACTIVE";
  }

  const lastSeenDate = parseWaLastSeen(lastSeen);

  if (!lastSeenDate) return "UNKNOWN";

  const now = getKyivNow();

  const diffHours =
    (now.getTime() - lastSeenDate.getTime()) /
    1000 /
    60 /
    60;

  if (diffHours > 3) {
    return "BAN";
  }

  return "ACTIVE";
}

async function syncWhatsAppSheetWithSupabase({
  supabase
}) {
  try {
    console.log("WA sheet sync started");

    const rows = await readAccountsFromSheet();

    let updated = 0;
    let checked = 0;

    for (let i = 0; i < rows.length; i++) {
      const rowNumber = i + 3;

      const id = rows[i][0] || "";
      const type = rows[i][1] || "";
      const account = rows[i][2] || "";
      const sheetStatus = rows[i][3] || "";
      const lastSeen = rows[i][4] || "";
      const adName = rows[i][5] || "";
      const operator = rows[i][6] || "";

      const sheetType = String(type || "")
        .trim()
        .toLowerCase();

      const sheetPhone = normalizePhone(account);

      if (sheetType !== "whatsapp") continue;
      if (!sheetPhone || sheetPhone.length < 8) continue;

      checked++;

      const newStatus =
        getWaStatusByLastSeen(lastSeen);

      if (normalizeStatus(sheetStatus) === newStatus) {
        continue;
      }

      await updateSheetRow(rowNumber, [
        id,
        "WhatsApp",
        account,
        newStatus,
        lastSeen,
        adName,
        operator
      ]);

      updated++;

      console.log(
        `WA sheet synced: row ${rowNumber}, ${sheetPhone} -> ${newStatus}, lastSeen=${lastSeen || "-"}`
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
        type || "Telegramm",
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
