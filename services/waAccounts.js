const {
  readAccountsFromSheet,
  updateSheetRow
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

async function syncWhatsAppSheetWithSupabase({
  supabase
}) {
  try {
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

    const connectedPhones = new Set(
      (waAccounts || [])
        .filter(acc => {
          const status = String(acc.status || "")
            .trim()
            .toLowerCase();

          return [
            "connected",
            "active",
            "open"
          ].includes(status);
        })
        .map(acc =>
          String(acc.phone || "")
            .replace(/[^\d]/g, "")
        )
        .filter(phone => phone.length >= 8)
    );

    let updated = 0;

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

      const sheetPhone = String(account || "")
        .replace(/[^\d]/g, "");

      if (sheetType !== "whatsapp") continue;
      if (!sheetPhone || sheetPhone.length < 8) continue;

      const newStatus = connectedPhones.has(sheetPhone)
        ? "ACTIVE"
        : "CONNECTION";

      if (
        String(sheetStatus || "")
          .trim()
          .toUpperCase() === newStatus
      ) {
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
        `WA sheet synced: ${sheetPhone} -> ${newStatus}`
      );
    }

    console.log(
      `WA sheet sync finished. Updated rows: ${updated}`
    );
  } catch (err) {
    console.log(
      "WA sheet sync error:",
      err.message
    );
  }
}

module.exports = {
  saveStatus,
  syncWhatsAppSheetWithSupabase
};
