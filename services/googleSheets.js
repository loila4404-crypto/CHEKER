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

let sheetsClient = null;

let writeQueue = Promise.resolve();
const readCache = new Map();

const READ_CACHE_MS = 15000;
const WRITE_DELAY_MS = 1500;

async function sleep(ms) {
  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );
}

async function getSheetsClient() {
  if (sheetsClient) {
    return sheetsClient;
  }

  const client = await auth.getClient();

  sheetsClient = google.sheets({
    version: "v4",
    auth: client
  });

  return sheetsClient;
}

function isQuotaError(err) {
  const message = String(err?.message || "")
    .toLowerCase();

  return (
    message.includes("quota") ||
    message.includes("rate limit") ||
    message.includes("write requests") ||
    err?.code === 429
  );
}

async function withRetry(fn, label) {
  let lastError = null;

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (!isQuotaError(err)) {
        throw err;
      }

      const waitMs = attempt * 10000;

      console.log(
        `${label} quota limit. Retry ${attempt}/5 after ${waitMs}ms`
      );

      await sleep(waitMs);
    }
  }

  throw lastError;
}

async function queuedWrite(fn, label) {
  writeQueue = writeQueue
    .then(async () => {
      await sleep(WRITE_DELAY_MS);

      return withRetry(fn, label);
    })
    .catch(err => {
      console.log(
        `${label} failed:`,
        err.message
      );
    });

  return writeQueue;
}

async function cachedRead(cacheKey, fn) {
  const cached = readCache.get(cacheKey);

  if (
    cached &&
    Date.now() - cached.time < READ_CACHE_MS
  ) {
    return cached.data;
  }

  const data = await withRetry(fn, cacheKey);

  readCache.set(cacheKey, {
    time: Date.now(),
    data
  });

  return data;
}

function clearReadCache() {
  readCache.clear();
}

async function readAccountsFromSheet() {
  const range =
    `${process.env.GOOGLE_SHEET_NAME}!A3:G1000`;

  return cachedRead(
    `read:${range}`,
    async () => {
      const sheets = await getSheetsClient();

      const res =
        await sheets.spreadsheets.values.get({
          spreadsheetId: process.env.GOOGLE_SHEET_ID,
          range
        });

      return res.data.values || [];
    }
  );
}

async function updateSheetRow(rowNumber, values) {
  clearReadCache();

  const range =
    `${process.env.GOOGLE_SHEET_NAME}!A${rowNumber}:G${rowNumber}`;

  return queuedWrite(
    async () => {
      const sheets = await getSheetsClient();

      await sheets.spreadsheets.values.update({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range,
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [values]
        }
      });
    },
    `updateSheetRow:${rowNumber}`
  );
}

async function appendSheetRow(values) {
  clearReadCache();

  const range =
    `${process.env.GOOGLE_SHEET_NAME}!A:G`;

  return queuedWrite(
    async () => {
      const sheets = await getSheetsClient();

      await sheets.spreadsheets.values.append({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range,
        valueInputOption: "USER_ENTERED",
        insertDataOption: "INSERT_ROWS",
        requestBody: {
          values: [values]
        }
      });
    },
    "appendSheetRow"
  );
}

async function readTelegramFromSheet() {
  const range =
    `${process.env.GOOGLE_SHEET_NAME}!H3:M1000`;

  return cachedRead(
    `read:${range}`,
    async () => {
      const sheets = await getSheetsClient();

      const res =
        await sheets.spreadsheets.values.get({
          spreadsheetId: process.env.GOOGLE_SHEET_ID,
          range
        });

      return res.data.values || [];
    }
  );
}

async function updateTelegramSheetRow(rowNumber, values) {
  clearReadCache();

  const range =
    `${process.env.GOOGLE_SHEET_NAME}!H${rowNumber}:M${rowNumber}`;

  return queuedWrite(
    async () => {
      const sheets = await getSheetsClient();

      await sheets.spreadsheets.values.update({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range,
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [values]
        }
      });
    },
    `updateTelegramSheetRow:${rowNumber}`
  );
}

async function clearWhatsAppSheetRow(rowNumber) {
  return updateSheetRow(rowNumber, [
    "",
    "WhatsApp",
    "",
    "",
    "",
    "",
    ""
  ]);
}

async function clearTelegramSheetRow(rowNumber) {
  return updateTelegramSheetRow(rowNumber, [
    "",
    "Telegramm",
    "",
    "",
    "",
    ""
  ]);
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
