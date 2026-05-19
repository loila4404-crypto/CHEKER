require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");

const { google } = require("googleapis");
const { chromium } = require("playwright");

const {
  createClient
} = require("@supabase/supabase-js");

const app = express();

const PORT =
  process.env.PORT || 3000;

const supabase =
  createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

const AUTH_BUCKET =
  process.env.AUTH_BUCKET ||
  "wa-web-auth";

const AUTH_FILE =
  "state.json";

const AUTH_DIR =
  path.join(__dirname, "auth");

const AUTH_PATH =
  path.join(AUTH_DIR, AUTH_FILE);

let browser = null;
let context = null;
let page = null;
let sheetsClient = null;
let checkSheetRunning = false;

function sleep(ms) {
  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );
}

function cleanPhone(phone) {
  return String(phone || "")
    .replace(/[^\d]/g, "");
}

async function downloadAuthFromSupabase() {
  try {
    if (!fs.existsSync(AUTH_DIR)) {
      fs.mkdirSync(AUTH_DIR, {
        recursive: true
      });
    }

    const { data, error } =
      await supabase.storage
        .from(AUTH_BUCKET)
        .download(AUTH_FILE);

    if (error || !data) {
      console.log("No auth in Supabase");
      return false;
    }

    const buffer =
      Buffer.from(await data.arrayBuffer());

    fs.writeFileSync(AUTH_PATH, buffer);

    console.log("Auth downloaded from Supabase");
    return true;
  } catch (err) {
    console.log("downloadAuth error:", err.message);
    return false;
  }
}

async function uploadAuthToSupabase() {
  try {
    if (!fs.existsSync(AUTH_PATH)) {
      return false;
    }

    const fileBuffer =
      fs.readFileSync(AUTH_PATH);

    const { error } =
      await supabase.storage
        .from(AUTH_BUCKET)
        .upload(AUTH_FILE, fileBuffer, {
          upsert: true,
          contentType: "application/json"
        });

    if (error) {
      console.log("uploadAuth error:", error.message);
      return false;
    }

    console.log("Auth uploaded to Supabase");
    return true;
  } catch (err) {
    console.log("uploadAuth crash:", err.message);
    return false;
  }
}

async function saveAuthState() {
  try {
    if (!context) return false;

    await context.storageState({
      path: AUTH_PATH
    });

    await uploadAuthToSupabase();

    return true;
  } catch (err) {
    console.log("saveAuthState error:", err.message);
    return false;
  }
}

async function isAuthorized() {
  if (!page) return false;

  try {
    const text =
      await page.locator("body").innerText({
        timeout: 5000
      });

    if (
      text.includes("Scan to log in") ||
      text.includes("Отсканируйте, чтобы войти") ||
      text.includes("Log in with phone number") ||
      text.includes("Войти по номеру телефона")
    ) {
      return false;
    }

    const inputCount =
      await page.locator('div[contenteditable="true"]').count();

    return inputCount > 0;
  } catch (err) {
    return false;
  }
}

async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;

  const googleCredentials =
    process.env.GOOGLE_SERVICE_JSON
      ? JSON.parse(process.env.GOOGLE_SERVICE_JSON)
      : null;

  const auth =
    new google.auth.GoogleAuth({
      credentials: googleCredentials || undefined,
      keyFile: googleCredentials
        ? undefined
        : process.env.GOOGLE_SERVICE_FILE,
      scopes: [
        "https://www.googleapis.com/auth/spreadsheets"
      ]
    });

  const client =
    await auth.getClient();

  sheetsClient =
    google.sheets({
      version: "v4",
      auth: client
    });

  return sheetsClient;
}

async function readAccountsFromSheet() {
  const sheets =
    await getSheetsClient();

  const range =
    `${process.env.GOOGLE_SHEET_NAME}!A3:G1000`;

  const res =
    await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range
    });

  return res.data.values || [];
}

async function updateSheetRow(rowNumber, values) {
  const sheets =
    await getSheetsClient();

  const range =
    `${process.env.GOOGLE_SHEET_NAME}!A${rowNumber}:G${rowNumber}`;

  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [values]
    }
  });
}

async function startBrowser() {
  console.log("Starting browser...");

  await downloadAuthFromSupabase();

  browser =
    await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox"
      ]
    });

  const contextOptions =
    fs.existsSync(AUTH_PATH)
      ? {
          storageState: AUTH_PATH
        }
      : {};

  context =
    await browser.newContext({
      ...contextOptions,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: {
        width: 1366,
        height: 768
      }
    });

  page =
    await context.newPage();

  await page.goto("https://web.whatsapp.com", {
    waitUntil: "domcontentloaded"
  });

  console.log("WhatsApp Web opened");

  try {
    await page.waitForSelector(
      'div[contenteditable="true"]',
      {
        timeout: 60000
      }
    );

    await saveAuthState();

    console.log("WhatsApp authorized. Session saved.");
  } catch (err) {
    console.log("WhatsApp not authorized. Use /qr.");
  }
}

async function ensureWhatsAppPage() {
  if (!page) {
    if (!browser || !context) {
      await startBrowser();
    } else {
      page = await context.newPage();
    }
  }

  const url = page.url();

  if (!url.includes("web.whatsapp.com")) {
    await page.goto("https://web.whatsapp.com", {
      waitUntil: "domcontentloaded"
    });
  }
}

async function getQrScreenshotBuffer() {
  await ensureWhatsAppPage();

  await page.goto("https://web.whatsapp.com", {
    waitUntil: "domcontentloaded"
  });

  await page.waitForTimeout(5000);

  if (await isAuthorized()) {
    await saveAuthState();

    return {
      authorized: true,
      buffer: await page.screenshot({
        type: "png",
        fullPage: false
      })
    };
  }

  const buffer =
    await page.screenshot({
      type: "png",
      fullPage: false
    });

  return {
    authorized: false,
    buffer
  };
}

async function checkPhoneLastSeen(phone) {
  const clean =
    cleanPhone(phone);

  if (!clean || clean.length < 8) {
    return {
      ok: false,
      error: "Bad phone"
    };
  }

  if (!page) {
    return {
      ok: false,
      error: "Browser not ready"
    };
  }

  const url =
    `https://web.whatsapp.com/send?phone=${clean}`;

  console.log(`Checking phone: ${clean}`);

  await page.goto(url, {
    waitUntil: "domcontentloaded"
  });

  await page.waitForTimeout(15000);

  const bodyText =
    await page.locator("body").innerText().catch(() => "");

  if (
    bodyText.includes("Scan to log in") ||
    bodyText.includes("Отсканируйте, чтобы войти")
  ) {
    return {
      ok: false,
      error: "WA Web not authorized"
    };
  }

  if (
    bodyText.includes("Phone number shared via url is invalid") ||
    bodyText.includes("Номер телефона, отправленный через ссылку, недействителен")
  ) {
    return {
      ok: true,
      phone: clean,
      exists: false,
      status: "BAN",
      lastSeen: "",
      headerLines: []
    };
  }

  let pageText = "";

  try {
    await page.waitForTimeout(5000);

    pageText =
      await page.locator("body").innerText({
        timeout: 10000
      });
  } catch (err) {
    pageText = "";
  }

  const lines =
    pageText
      .split("\n")
      .map(x => x.trim())
      .filter(Boolean);

  const usefulLine =
    lines.find(line =>
      line.toLowerCase().includes("online") ||
      line.toLowerCase().includes("в сети") ||
      line.toLowerCase().includes("last seen") ||
      line.toLowerCase().includes("был") ||
      line.toLowerCase().includes("была")
    ) || "";

  return {
    ok: true,
    phone: clean,
    exists: true,
    status: usefulLine ? "LIVE" : "UNKNOWN",
    lastSeen: usefulLine,
    headerLines: lines
  };
}

async function checkSheet() {
  if (checkSheetRunning) {
    return {
      ok: false,
      error: "Check already running"
    };
  }

  if (!(await isAuthorized())) {
    return {
      ok: false,
      error: "WA Web not authorized"
    };
  }

  checkSheetRunning = true;

  let checked = 0;
  let live = 0;
  let ban = 0;
  let unknown = 0;
  let errors = 0;

  try {
    const rows =
      await readAccountsFromSheet();

    for (let i = 0; i < rows.length; i++) {
      const rowNumber = i + 3;

      const id = rows[i][0] || "";
      const type = rows[i][1] || "";
      const account = rows[i][2] || "";
      const oldStatus = rows[i][3] || "";
      const oldLastSeen = rows[i][4] || "";
      const adName = rows[i][5] || "";
      const operator = rows[i][6] || "";

      if (type !== "WhatsApp") continue;

      const phone =
        cleanPhone(account);

      if (!phone || phone.length < 8) continue;

      checked++;

      try {
        const result =
          await checkPhoneLastSeen(phone);

        let newStatus = "UNKNOWN";
        let lastSeenText = oldLastSeen || "";

        if (result.exists === false) {
          newStatus = "BAN";
          lastSeenText = "";
          ban++;
        } else if (result.lastSeen) {
          newStatus = "LIVE";
          lastSeenText = result.lastSeen;
          live++;
        } else {
          newStatus = "UNKNOWN";
          unknown++;
        }

        await updateSheetRow(rowNumber, [
          id,
          "WhatsApp",
          phone,
          newStatus,
          lastSeenText,
          adName,
          operator
        ]);

        console.log(
          `Sheet row ${rowNumber}: ${phone} ${oldStatus} -> ${newStatus}, lastSeen=${lastSeenText || "-"}`
        );
      } catch (err) {
        errors++;

        console.log(
          `Check sheet phone error ${phone}:`,
          err.message
        );

        await updateSheetRow(rowNumber, [
          id,
          "WhatsApp",
          phone,
          "ERROR",
          oldLastSeen,
          adName,
          operator
        ]);
      }

      await sleep(20000);
    }

    await saveAuthState();

    return {
      ok: true,
      checked,
      live,
      ban,
      unknown,
      errors
    };
  } finally {
    checkSheetRunning = false;
  }
}

app.get("/", (req, res) => {
  res.send("WA WEB CHECKER OK");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    running: checkSheetRunning
  });
});

app.get("/auth-status", async (req, res) => {
  try {
    const authorized =
      await isAuthorized();

    res.json({
      ok: true,
      authorized
    });
  } catch (err) {
    res.json({
      ok: false,
      error: err.message
    });
  }
});

app.get("/qr", async (req, res) => {
  try {
    const result =
      await getQrScreenshotBuffer();

    res.setHeader(
      "Content-Type",
      "image/png"
    );

    res.setHeader(
      "X-WA-Authorized",
      result.authorized ? "true" : "false"
    );

    res.end(result.buffer);
  } catch (err) {
    console.log("QR error:", err.message);

    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

app.get("/check", async (req, res) => {
  try {
    const result =
      await checkPhoneLastSeen(req.query.phone);

    res.json(result);
  } catch (err) {
    console.log("Check error:", err.message);

    res.json({
      ok: false,
      error: err.message
    });
  }
});

app.get("/check-sheet", async (req, res) => {
  try {
    const result =
      await checkSheet();

    res.json(result);
  } catch (err) {
    console.log("Check sheet error:", err.message);

    res.json({
      ok: false,
      error: err.message
    });
  }
});

app.listen(PORT, async () => {
  console.log(`Server started on ${PORT}`);

  await startBrowser();
});
