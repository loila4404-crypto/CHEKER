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

  await syncWhatsAppSheetWithSupabase({
    supabase
  });
}

async function syncWhatsAppSheetWithSupabase({
  supabase
}) {
  try {
    const rows = await readAccountsFromSheet();
    console.log("SHEET ROWS:", rows);

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

    console.log(
      "CONNECTED PHONES:",
      [...connectedPhones]
    );

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

      console.log(
        "CHECKING ROW:",
        {
          rowNumber,
          sheetType,
          sheetPhone,
          sheetStatus
        }
      );

      if (sheetType !== "whatsapp") continue;
      if (!sheetPhone || sheetPhone.length < 8) continue;

      const newStatus = connectedPhones.has(sheetPhone)
        ? "ACTIVE"
        : "CONNECTION";

      await updateSheetRow(rowNumber, [
        id,
        "WhatsApp",
        account,
        newStatus,
        adName,
        operator
      ]);

      console.log(
        `WA sheet force synced: ${sheetPhone} -> ${newStatus}`
      );
    }
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
