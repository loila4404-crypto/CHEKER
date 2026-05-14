const { google } = require("googleapis");

const googleCredentials =
  process.env.GOOGLE_SERVICE_JSON
    ? JSON.parse(process.env.GOOGLE_SERVICE_JSON)
    : null;

const auth = new google.auth.GoogleAuth({
  credentials: googleCredentials || undefined,
  keyFile: googleCredentials
    ? undefined
    : process.env.GOOGLE_SERVICE_FILE,

  scopes: [
    "https://www.googleapis.com/auth/spreadsheets"
  ]
});

async function getSheetsClient() {
  const client = await auth.getClient();

  return google.sheets({
    version: "v4",
    auth: client
  });
}

async function readAccountsFromSheet() {
  const sheets = await getSheetsClient();

  const range = `${process.env.GOOGLE_SHEET_NAME}!A2:F`;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range
  });

  return res.data.values || [];
}

async function updateSheetRow(rowNumber, values) {
  const sheets = await getSheetsClient();

  const range = `${process.env.GOOGLE_SHEET_NAME}!A${rowNumber}:F${rowNumber}`;

  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [values]
    }
  });
}

async function appendSheetRow(values) {
  const sheets = await getSheetsClient();

  const range = `${process.env.GOOGLE_SHEET_NAME}!A:F`;

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [values]
    }
  });
}

async function readTelegramFromSheet() {
  const sheets = await getSheetsClient();

  const range = `${process.env.GOOGLE_SHEET_NAME}!H3:M`;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range
  });

  return res.data.values || [];
}

async function updateTelegramSheetRow(rowNumber, values) {
  const sheets = await getSheetsClient();

  const range = `${process.env.GOOGLE_SHEET_NAME}!H${rowNumber}:M${rowNumber}`;

  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [values]
    }
  });
}

async function clearWhatsAppSheetRow(rowNumber) {
  const sheets = await getSheetsClient();

  await sheets.spreadsheets.values.clear({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `${process.env.GOOGLE_SHEET_NAME}!A${rowNumber}:F${rowNumber}`
  });
}

async function clearTelegramSheetRow(rowNumber) {
  const sheets = await getSheetsClient();

  await sheets.spreadsheets.values.clear({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `${process.env.GOOGLE_SHEET_NAME}!H${rowNumber}:M${rowNumber}`
  });
}

module.exports = {
  readAccountsFromSheet,
  updateSheetRow,
  appendSheetRow,
  readTelegramFromSheet,
  updateTelegramSheetRow,
  clearWhatsAppSheetRow,
  clearTelegramSheetRow
};