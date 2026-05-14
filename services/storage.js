const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const tar = require("tar");

const {
  encryptBuffer,
  decryptBuffer
} = require("../utils/crypto");

async function uploadSessionToStorage({
  phone,
  supabase,
  sessionSecret,
  bucket
}) {
  if (!sessionSecret) {
    console.log("SESSION_SECRET missing");
    return;
  }

  const sessionDir = path.join(
    __dirname,
    "..",
    "sessions",
    `wa_${phone}`
  );

  if (!fs.existsSync(sessionDir)) {
    return;
  }

  const tmpTar = path.join(
    __dirname,
    "..",
    `wa_${phone}.tar.gz`
  );

  const storagePath =
    `wa_${phone}/session.tar.gz.enc`;

  await tar.c(
    {
      gzip: true,
      file: tmpTar,
      cwd: path.join(__dirname, "..", "sessions")
    },
    [`wa_${phone}`]
  );

  const raw = await fsp.readFile(tmpTar);

  const encrypted = encryptBuffer(
    raw,
    sessionSecret
  );

  const { error } = await supabase.storage
    .from(bucket)
    .upload(storagePath, encrypted, {
      upsert: true,
      contentType: "application/octet-stream"
    });

  await fsp.unlink(tmpTar).catch(() => {});

  if (error) {
    console.log(
      `Upload session error ${phone}:`,
      error.message
    );

    return;
  }

  console.log(
    `Session ${phone} uploaded`
  );
}

async function restoreSessionFromStorage({
  phone,
  supabase,
  sessionSecret,
  bucket
}) {
  if (!sessionSecret) {
    console.log("SESSION_SECRET missing");
    return;
  }

  const sessionRoot = path.join(
    __dirname,
    "..",
    "sessions"
  );

  const sessionDir = path.join(
    sessionRoot,
    `wa_${phone}`
  );

  const tmpTar = path.join(
    __dirname,
    "..",
    `restore_${phone}.tar.gz`
  );

  const storagePath =
    `wa_${phone}/session.tar.gz.enc`;

  if (fs.existsSync(sessionDir)) {
    return;
  }

  const { data, error } = await supabase.storage
    .from(bucket)
    .download(storagePath);

  if (error || !data) {
    console.log(
      `No saved session for ${phone}`
    );

    return;
  }

  await fsp.mkdir(sessionRoot, {
    recursive: true
  });

  const encrypted = Buffer.from(
    await data.arrayBuffer()
  );

  const decrypted = decryptBuffer(
    encrypted,
    sessionSecret
  );

  await fsp.writeFile(tmpTar, decrypted);

  await tar.x({
    file: tmpTar,
    cwd: sessionRoot
  });

  await fsp.unlink(tmpTar).catch(() => {});

  console.log(
    `Session ${phone} restored`
  );
}

module.exports = {
  uploadSessionToStorage,
  restoreSessionFromStorage
};