const {
  readAccountsFromSheet,
  updateSheetRow
} = require("./googleSheets");

async function markSheetBanAndReport({
  phone,
  reason = "BAN",
  bot,
  reportChatId
}) {
  try {
    const rows = await readAccountsFromSheet();

    for (let i = 0; i < rows.length; i++) {
      const rowNumber = i + 3;

      const id = rows[i][0] || "";
      const type = rows[i][1] || "";
      const account = rows[i][2] || "";
      const adName = rows[i][4] || "";
      const operator = rows[i][5] || "";

      const sheetPhone = String(account)
        .replace(/[^\d]/g, "");

      if (
        String(type).trim().toLowerCase() === "whatsapp" &&
        sheetPhone === String(phone).replace(/[^\d]/g, "")
      ) {
        await updateSheetRow(rowNumber, [
          id,
          "WhatsApp",
          account,
          "BAN",
          adName,
          operator
        ]);

        break;
      }
    }

    if (bot && reportChatId) {
      await bot.sendMessage(
        reportChatId,
        `⛔ WhatsApp BAN: ${phone}

Причина: ${reason}`
      );
    }
  } catch (err) {
    console.log(
      "markSheetBanAndReport error:",
      err.message
    );
  }
}

module.exports = {
  markSheetBanAndReport
};
